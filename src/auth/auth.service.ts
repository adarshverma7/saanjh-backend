import {
  Injectable,
  Logger,
  UnauthorizedException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FirebaseService } from './firebase.service';
import { TooManyRequestsException } from '../shared/exceptions/too-many-requests.exception';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import axios from 'axios';
import {
  hashPhone,
  hashOtp,
  hashRefreshToken,
  generateOtp,
  maskPhone,
} from '../shared/helpers/phone.helper';

export interface DeviceInfo {
  device_id: string;
  device_type?: string;
  app_version?: string;
  fcm_token?: string;
  ip?: string;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  is_new_user: boolean;
  user: UserProfile;
}

export interface UserProfile {
  id: string;
  phone: string;           // masked
  name: string | null;
  language: string;
  timezone: string;
  is_onboarded: boolean;
  is_verified: boolean;
}

interface DbUser {
  id: string;
  phone: string;
  name: string | null;
  language: string;
  timezone: string;
  is_onboarded: boolean;
  is_verified: boolean;
  is_active: boolean;
  deleted_at: Date | null;
}

export interface SessionInfo {
  id: string;
  user_id: string;
  device_id: string;
  device_type: string | null;
  app_version: string | null;
  os_version: string | null;
  is_active: boolean;
  last_used_at: Date;
  created_at: Date;
}

// Internal — not exported (only used within this file)
interface DbSession {
  id: string;
  user_id: string;
  device_id: string;
  is_active: boolean;
  last_used_at: Date;
}

interface DbOtp {
  id: string;
  otp_hash: string;
  attempt_count: number;
  expires_at: Date;
}

interface RateLimitRow {
  count: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    private readonly jwtService: JwtService,
    private readonly eventEmitter: EventEmitter2,
    private readonly firebaseService: FirebaseService,
  ) {}

  // ── Send OTP ────────────────────────────────────────────────────────────────

  async sendOtp(phone: string, ip?: string): Promise<void> {
    // Rate limit: 3 per phone per 10 minutes
    await this.enforceRateLimit(`otp:${phone}`, 600, 3, 'OTP_RATE_LIMIT');

    // Rate limit: 15 per IP per hour
    if (ip) {
      await this.enforceRateLimit(`otp_ip:${ip}`, 3600, 15, 'OTP_RATE_LIMIT_IP');
    }

    const otp = generateOtp();
    const otpHash = hashOtp(otp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Invalidate previous unused OTPs for this phone
    await this.db.query(
      `UPDATE otp_verifications
       SET is_used = true
       WHERE phone = $1 AND is_used = false AND purpose = 'login'`,
      [phone],
    );

    // Store hashed OTP
    await this.db.query(
      `INSERT INTO otp_verifications (phone, otp_hash, purpose, expires_at)
       VALUES ($1, $2, 'login', $3)`,
      [phone, otpHash, expiresAt],
    );

    // Deliver OTP
    await this.deliverOtp(phone, otp);
  }

  // ── Verify OTP ──────────────────────────────────────────────────────────────

  async verifyOtp(
    phone: string,
    otp: string,
    deviceInfo: DeviceInfo,
  ): Promise<AuthTokens> {
    // Find the most recent valid OTP for this phone
    const otpRows = await this.db.query<DbOtp[]>(
      `SELECT id, otp_hash, attempt_count, expires_at
       FROM otp_verifications
       WHERE phone = $1
         AND purpose = 'login'
         AND is_used = false
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [phone],
    );

    if (!otpRows.length) {
      throw new UnauthorizedException({
        error: 'OTP_EXPIRED',
        message: 'OTP has expired or was not found. Please request a new one.',
      });
    }

    const record = otpRows[0];

    // Brute-force protection: 5 wrong attempts lock this OTP
    if (record.attempt_count >= 5) {
      throw new TooManyRequestsException({
        error: 'TOO_MANY_ATTEMPTS',
        message: 'Too many incorrect attempts. Please request a new OTP.',
      });
    }

    const incomingHash = hashOtp(otp);
    if (incomingHash !== record.otp_hash) {
      // Increment attempt_count — do not mark as used yet (allow retry)
      await this.db.query(
        `UPDATE otp_verifications SET attempt_count = attempt_count + 1 WHERE id = $1`,
        [record.id],
      );
      throw new UnauthorizedException({
        error: 'INVALID_OTP',
        message: 'OTP is incorrect.',
      });
    }

    // Mark OTP as consumed
    await this.db.query(
      `UPDATE otp_verifications SET is_used = true WHERE id = $1`,
      [record.id],
    );

    // ── Find or create user ──────────────────────────────────────────────────

    let isNewUser = false;
    let user: DbUser;

    const existingRows = await this.db.query<DbUser[]>(
      `SELECT id, phone, name, language, timezone, is_onboarded, is_verified,
              is_active, deleted_at
       FROM users WHERE phone = $1`,
      [phone],
    );

    if (existingRows.length) {
      user = existingRows[0];

      if (user.deleted_at !== null) {
        throw new ForbiddenException({
          error: 'ACCOUNT_DELETED',
          message: 'This account has been deleted. Contact support if this is a mistake.',
        });
      }

      // Update is_verified on first successful OTP if not already set
      if (!user.is_verified) {
        await this.db.query(
          `UPDATE users SET is_verified = true, updated_at = NOW() WHERE id = $1`,
          [user.id],
        );
        user.is_verified = true;
      }
    } else {
      // New user — create account
      isNewUser = true;
      const salt = this.config.get<string>('phoneHashSalt') ?? '';
      const phoneHash = hashPhone(phone, salt);

      const newRows = await this.db.query<DbUser[]>(
        `INSERT INTO users (phone, phone_hash, is_verified, language, timezone)
         VALUES ($1, $2, true, 'en', 'Asia/Kolkata')
         RETURNING id, phone, name, language, timezone, is_onboarded,
                   is_verified, is_active, deleted_at`,
        [phone, phoneHash],
      );
      user = newRows[0];

      // Log new user creation
      await this.writeAuditLog(user.id, 'user.created', 'user', user.id);

      // Emit event for auto-match: ConnectionsService listens and checks
      // if any pending invite was sent to this phone hash.
      // Fire-and-forget — must never block or fail the signup flow.
      this.eventEmitter.emit('user.created', {
        userId: user.id,
        phoneHash,
        salt,
      });
    }

    // ── Upsert device session ────────────────────────────────────────────────

    const session = await this.upsertDeviceSession(user.id, deviceInfo);

    // ── Generate tokens ──────────────────────────────────────────────────────

    const { accessToken, refreshToken } = this.generateTokenPair(
      user.id,
      session.id,
      deviceInfo.device_id,
    );

    // Store hashed refresh token in the session
    const refreshHash = hashRefreshToken(refreshToken);
    await this.db.query(
      `UPDATE device_sessions
       SET refresh_token_hash = $1, last_used_at = NOW()
       WHERE id = $2`,
      [refreshHash, session.id],
    );

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      is_new_user: isNewUser,
      user: this.toProfile(user),
    };
  }

  // ── Firebase Phone Auth ──────────────────────────────────────────────────

  /**
   * Verifies a Firebase ID token (issued after phone OTP verified in Flutter)
   * and returns our own JWT pair. Creates a new user if first login.
   */
  async verifyFirebaseToken(
    idToken: string,
    deviceInfo: DeviceInfo,
  ): Promise<AuthTokens> {
    // FirebaseService does the token verification — it throws if invalid
    const { phone } = await this.firebaseService.verifyIdToken(idToken);

    // ── Find or create user (same logic as verifyOtp) ────────────────────────
    let isNewUser = false;
    let user: DbUser;

    const existingRows = await this.db.query<DbUser[]>(
      `SELECT id, phone, name, language, timezone, is_onboarded, is_verified,
              is_active, deleted_at
       FROM users WHERE phone = $1`,
      [phone],
    );

    if (existingRows.length) {
      user = existingRows[0];
      if (user.deleted_at !== null) {
        throw new ForbiddenException({
          error: 'ACCOUNT_DELETED',
          message: 'This account has been deleted. Contact support if this is a mistake.',
        });
      }
      if (!user.is_verified) {
        await this.db.query(
          `UPDATE users SET is_verified = true, updated_at = NOW() WHERE id = $1`,
          [user.id],
        );
        user.is_verified = true;
      }
    } else {
      isNewUser = true;
      const salt = this.config.get<string>('phoneHashSalt') ?? '';
      const phoneHash = hashPhone(phone, salt);
      const newRows = await this.db.query<DbUser[]>(
        `INSERT INTO users (phone, phone_hash, is_verified, language, timezone)
         VALUES ($1, $2, true, 'en', 'Asia/Kolkata')
         RETURNING id, phone, name, language, timezone, is_onboarded,
                   is_verified, is_active, deleted_at`,
        [phone, phoneHash],
      );
      user = newRows[0];
      await this.writeAuditLog(user.id, 'user.created', 'user', user.id);
      this.eventEmitter.emit('user.created', { userId: user.id, phoneHash, salt });
    }

    const session = await this.upsertDeviceSession(user.id, deviceInfo);
    const { accessToken, refreshToken } = this.generateTokenPair(
      user.id, session.id, deviceInfo.device_id,
    );
    const refreshHash = hashRefreshToken(refreshToken);
    await this.db.query(
      `UPDATE device_sessions SET refresh_token_hash = $1, last_used_at = NOW() WHERE id = $2`,
      [refreshHash, session.id],
    );

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      is_new_user: isNewUser,
      user: this.toProfile(user),
    };
  }

  // ── Refresh Token ────────────────────────────────────────────────────────

  async refreshToken(
    incomingRefreshToken: string,
    deviceId: string,
  ): Promise<Omit<AuthTokens, 'is_new_user' | 'user'>> {
    const tokenHash = hashRefreshToken(incomingRefreshToken);

    const sessionRows = await this.db.query<DbSession[]>(
      `SELECT id, user_id, device_id, is_active
       FROM device_sessions
       WHERE refresh_token_hash = $1
         AND device_id = $2
         AND is_active = true
       LIMIT 1`,
      [tokenHash, deviceId],
    );

    if (!sessionRows.length) {
      throw new UnauthorizedException({
        error: 'INVALID_TOKEN',
        message: 'Refresh token is invalid or has already been used.',
      });
    }

    const session = sessionRows[0];

    // Rotate: generate new token pair, immediately nullify old hash
    const { accessToken, refreshToken: newRefreshToken } = this.generateTokenPair(
      session.user_id,
      session.id,
      deviceId,
    );

    const newHash = hashRefreshToken(newRefreshToken);

    await this.db.query(
      `UPDATE device_sessions
       SET refresh_token_hash = $1, last_used_at = NOW()
       WHERE id = $2`,
      [newHash, session.id],
    );

    return {
      access_token: accessToken,
      refresh_token: newRefreshToken,
    };
  }

  // ── Logout ───────────────────────────────────────────────────────────────

  async logout(userId: string, deviceId: string): Promise<void> {
    await this.db.query(
      `UPDATE device_sessions
       SET is_active = false, refresh_token_hash = NULL
       WHERE user_id = $1 AND device_id = $2`,
      [userId, deviceId],
    );
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  async getSessions(userId: string): Promise<SessionInfo[]> {
    return this.db.query<SessionInfo[]>(
      `SELECT id, user_id, device_id, device_type, app_version,
              os_version, is_active, last_used_at, created_at
       FROM device_sessions
       WHERE user_id = $1 AND is_active = true
       ORDER BY last_used_at DESC`,
      [userId],
    );
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.db.query(
      `UPDATE device_sessions
       SET is_active = false, refresh_token_hash = NULL
       WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
  }

  // ── Account Deletion ─────────────────────────────────────────────────────

  async requestAccountDeletion(userId: string, phone: string): Promise<void> {
    // Rate limit deletion requests
    await this.enforceRateLimit(`del:${userId}`, 3600, 3, 'DELETION_RATE_LIMIT');

    const otp = generateOtp();
    const otpHash = hashOtp(otp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Invalidate previous deletion OTPs
    await this.db.query(
      `UPDATE otp_verifications
       SET is_used = true
       WHERE phone = $1 AND is_used = false AND purpose = 'delete_account'`,
      [phone],
    );

    await this.db.query(
      `INSERT INTO otp_verifications (phone, otp_hash, purpose, expires_at)
       VALUES ($1, $2, 'delete_account', $3)`,
      [phone, otpHash, expiresAt],
    );

    await this.deliverOtp(phone, otp, 'account deletion');
  }

  async confirmAccountDeletion(
    userId: string,
    phone: string,
    otp: string,
  ): Promise<void> {
    // Verify OTP (same logic but purpose='delete_account')
    const rows = await this.db.query<DbOtp[]>(
      `SELECT id, otp_hash, attempt_count, expires_at
       FROM otp_verifications
       WHERE phone = $1
         AND purpose = 'delete_account'
         AND is_used = false
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [phone],
    );

    if (!rows.length) {
      throw new UnauthorizedException({
        error: 'OTP_EXPIRED',
        message: 'Deletion OTP has expired. Please request a new one.',
      });
    }

    const record = rows[0];

    if (record.attempt_count >= 5) {
      throw new TooManyRequestsException({
        error: 'TOO_MANY_ATTEMPTS',
        message: 'Too many incorrect attempts.',
      });
    }

    if (hashOtp(otp) !== record.otp_hash) {
      await this.db.query(
        `UPDATE otp_verifications SET attempt_count = attempt_count + 1 WHERE id = $1`,
        [record.id],
      );
      throw new UnauthorizedException({
        error: 'INVALID_OTP',
        message: 'OTP is incorrect.',
      });
    }

    await this.db.query(
      `UPDATE otp_verifications SET is_used = true WHERE id = $1`,
      [record.id],
    );

    // Soft delete the user
    await this.db.query(
      `UPDATE users SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [userId],
    );

    // Deactivate all sessions (force logout from all devices)
    await this.db.query(
      `UPDATE device_sessions
       SET is_active = false, refresh_token_hash = NULL
       WHERE user_id = $1`,
      [userId],
    );

    await this.writeAuditLog(userId, 'account.delete_requested', 'user', userId);

    this.logger.log(`Account deletion requested for user ${userId}. Hard delete in 30 days.`);
    // TODO Prompt 09: queue cleanup job { type: 'delete_user_data', userId, runAt: +30days }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async enforceRateLimit(
    key: string,
    windowSeconds: number,
    maxRequests: number,
    errorCode: string,
  ): Promise<void> {
    // Atomic UPSERT: increment count within window, or reset if window expired
    const rows = await this.db.query<RateLimitRow[]>(
      `INSERT INTO rate_limit_counters (key, count, window_start, updated_at)
       VALUES ($1, 1, NOW(), NOW())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE
           WHEN rate_limit_counters.window_start > NOW() - (INTERVAL '1 second' * $2)
           THEN rate_limit_counters.count + 1
           ELSE 1
         END,
         window_start = CASE
           WHEN rate_limit_counters.window_start > NOW() - (INTERVAL '1 second' * $2)
           THEN rate_limit_counters.window_start
           ELSE NOW()
         END,
         updated_at = NOW()
       RETURNING count`,
      [key, windowSeconds],
    );

    const count = parseInt(rows[0].count, 10);
    if (count > maxRequests) {
      const minutes = Math.ceil(windowSeconds / 60);
      throw new TooManyRequestsException({
        error: errorCode,
        message: `Too many requests. Please wait ${minutes} minute${minutes > 1 ? 's' : ''} before trying again.`,
      });
    }
  }

  private async upsertDeviceSession(
    userId: string,
    deviceInfo: DeviceInfo,
  ): Promise<{ id: string }> {
    // Upsert: update existing session or create new one
    const rows = await this.db.query<{ id: string }[]>(
      `INSERT INTO device_sessions
         (user_id, device_id, device_type, app_version, fcm_token, is_active, last_used_at)
       VALUES ($1, $2, $3, $4, $5, true, NOW())
       ON CONFLICT (user_id, device_id) DO UPDATE SET
         device_type  = EXCLUDED.device_type,
         app_version  = EXCLUDED.app_version,
         fcm_token    = COALESCE(EXCLUDED.fcm_token, device_sessions.fcm_token),
         is_active    = true,
         last_used_at = NOW(),
         updated_at   = NOW()
       RETURNING id`,
      [
        userId,
        deviceInfo.device_id,
        deviceInfo.device_type ?? null,
        deviceInfo.app_version ?? null,
        deviceInfo.fcm_token ?? null,
      ],
    );

    const sessionId = rows[0].id;

    // Enforce max 5 active devices per user
    await this.db.query(
      `UPDATE device_sessions SET is_active = false, refresh_token_hash = NULL
       WHERE user_id = $1
         AND is_active = true
         AND id NOT IN (
           SELECT id FROM device_sessions
           WHERE user_id = $1 AND is_active = true
           ORDER BY last_used_at DESC
           LIMIT 5
         )`,
      [userId],
    );

    return { id: sessionId };
  }

  private generateTokenPair(
    userId: string,
    sessionId: string,
    deviceId: string,
  ): { accessToken: string; refreshToken: string } {
    const privateKey = this.config.get<string>('jwt.privateKey') ?? '';

    const accessToken = this.jwtService.sign(
      { sub: userId, session_id: sessionId, device_id: deviceId },
      {
        algorithm: 'RS256',
        privateKey,
        expiresIn: '15m',
      },
    );

    // 64 random bytes as hex — opaque, not a JWT
    const refreshToken = crypto.randomBytes(64).toString('hex');

    return { accessToken, refreshToken };
  }

  private async deliverOtp(
    phone: string,
    otp: string,
    purpose = 'login',
  ): Promise<void> {
    const env = this.config.get<string>('nodeEnv');

    if (env !== 'production') {
      // Development / staging: log OTP clearly — never send real SMS
      this.logger.warn(`[DEV OTP] ${phone} → ${otp} (purpose: ${purpose})`);
      return;
    }

    // Production: send via MSG91
    const authKey = this.config.get<string>('msg91.authKey');
    if (!authKey) {
      // MSG91 not configured — log OTP so developer can test manually
      // REMOVE THIS LOG before going fully public (replace with real SMS key)
      this.logger.warn(`[NO-SMS] OTP for ${maskPhone(phone)}: ${otp} — add MSG91_AUTH_KEY to enable real SMS`);
      return;
    }

    try {
      await axios.post(
        'https://api.msg91.com/api/v5/otp',
        {
          mobile: phone.replace('+', ''),  // MSG91 expects without +
          otp,
          // template_id is set in MSG91 dashboard and registered with DLT
        },
        {
          headers: {
            authkey: authKey,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );
    } catch (err) {
      this.logger.error(`MSG91 SMS failed for ${maskPhone(phone)}`, err);
      throw new ServiceUnavailableException({
        error: 'SMS_FAILED',
        message: 'Failed to send OTP. Please try again.',
      });
    }
  }

  /** Returns the raw (unmasked) phone for a user. Used only for OTP delivery. */
  async getRawPhone(userId: string): Promise<string> {
    const rows = await this.db.query<{ phone: string }[]>(
      `SELECT phone FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!rows.length) {
      throw new UnauthorizedException({ error: 'USER_NOT_FOUND', message: 'User not found' });
    }
    return rows[0].phone;
  }

  private async writeAuditLog(
    userId: string,
    action: string,
    resourceType: string,
    resourceId: string,
  ): Promise<void> {
    await this.db
      .query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, action, resourceType, resourceId],
      )
      .catch((err: unknown) => {
        // Audit log failures must never break the main flow
        this.logger.error('Audit log write failed', err);
      });
  }

  private toProfile(user: DbUser): UserProfile {
    return {
      id: user.id,
      phone: maskPhone(user.phone),
      name: user.name,
      language: user.language,
      timezone: user.timezone,
      is_onboarded: user.is_onboarded,
      is_verified: user.is_verified,
    };
  }
}
