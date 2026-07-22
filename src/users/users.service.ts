import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { StorageService } from '../shared/storage/storage.service';
import { returningRows } from '../shared/database/query-utils';
import { maskPhone } from '../shared/helpers/phone.helper';
import type { UpdateProfileDto } from './dto/update-profile.dto';
import type { UpdateSettingsDto } from './dto/update-settings.dto';

// ── Public interfaces ────────────────────────────────────────────────────────

export interface UserProfile {
  id: string;
  phone: string;           // always masked — last 4 digits visible
  name: string | null;
  language: string;
  timezone: string;
  avatar_url: string | null;
  is_onboarded: boolean;
  is_verified: boolean;
  last_active_at: Date | null;
}

export interface OnboardingStatus {
  step: 'profile' | 'connection' | 'complete';
  profile_complete: boolean;
  has_connection: boolean;
}

export interface UserSettings {
  // User identity
  language: string;
  timezone: string;
  // Notification preferences
  new_entry: boolean;
  flicker_received: boolean;
  streak_reminder: boolean;
  streak_reminder_time: string;
  occasion_reminders: boolean;
  morning_ritual: boolean;
  morning_ritual_time: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
}

// ── Internal DB row type ─────────────────────────────────────────────────────

interface DbUser {
  id: string;
  phone: string;
  name: string | null;
  language: string;
  timezone: string;
  avatar_key: string | null;
  is_onboarded: boolean;
  is_verified: boolean;
  is_active: boolean;
  last_active_at: Date | null;
  deleted_at: Date | null;
}

interface DbNotifPref {
  new_entry: boolean;
  flicker_received: boolean;
  streak_reminder: boolean;
  streak_reminder_time: string;
  occasion_reminders: boolean;
  morning_ritual: boolean;
  morning_ritual_time: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
}

// Default notification preferences (used when no row exists yet)
const NOTIF_DEFAULTS: DbNotifPref = {
  new_entry: true,
  flicker_received: true,
  streak_reminder: true,
  streak_reminder_time: '20:00:00',
  occasion_reminders: true,
  morning_ritual: true,
  morning_ritual_time: '08:00:00',
  quiet_hours_start: '22:00:00',
  quiet_hours_end: '07:00:00',
};

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly storage: StorageService,
  ) {}

  // ── Profile ────────────────────────────────────────────────────────────────

  async getProfile(userId: string): Promise<UserProfile> {
    const rows = await this.db.query<DbUser[]>(
      `SELECT id, phone, name, language, timezone, avatar_key,
              is_onboarded, is_verified, is_active, last_active_at, deleted_at
       FROM users
       WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );

    if (!rows.length) {
      throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'User not found' });
    }

    return this.toProfile(rows[0]);
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<UserProfile> {
    // Build dynamic SET clause for only the provided fields
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (dto.name !== undefined) {
      fields.push(`name = $${idx++}`);
      values.push(dto.name.trim());
    }
    if (dto.language !== undefined) {
      fields.push(`language = $${idx++}`);
      values.push(dto.language);
    }
    if (dto.date_of_birth !== undefined) {
      fields.push(`date_of_birth = $${idx++}`);
      values.push(dto.date_of_birth);
    }
    if (dto.timezone !== undefined) {
      fields.push(`timezone = $${idx++}`);
      values.push(dto.timezone);
    }

    if (!fields.length) {
      // Nothing to update — just return current profile
      return this.getProfile(userId);
    }

    fields.push(`updated_at = NOW()`);
    values.push(userId);

    const rows = returningRows<DbUser>(await this.db.query(
      `UPDATE users SET ${fields.join(', ')}
       WHERE id = $${idx} AND deleted_at IS NULL
       RETURNING id, phone, name, language, timezone, avatar_key,
                 is_onboarded, is_verified, is_active, last_active_at, deleted_at`,
      values,
    ));

    if (!rows.length) {
      throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'User not found' });
    }

    return this.toProfile(rows[0]);
  }

  // ── Avatar ─────────────────────────────────────────────────────────────────

  async getAvatarUploadUrl(
    userId: string,
  ): Promise<{ upload_url: string; avatar_key: string }> {
    const avatarKey = StorageService.avatarKey(userId);
    const uploadUrl = await this.storage.getSignedUploadUrl(avatarKey);
    return { upload_url: uploadUrl, avatar_key: avatarKey };
  }

  async updateAvatar(userId: string, avatarKey: string): Promise<UserProfile> {
    // Security: key must belong to this user
    if (!avatarKey.startsWith(`avatars/${userId}/`)) {
      throw new BadRequestException({
        error: 'INVALID_AVATAR_KEY',
        message: 'Avatar key does not belong to this user',
      });
    }

    // Verify the upload actually completed in R2
    const exists = await this.storage.objectExists(avatarKey);
    if (!exists) {
      throw new BadRequestException({
        error: 'AVATAR_NOT_UPLOADED',
        message: 'Avatar file not found. Please upload the image first.',
      });
    }

    // Fetch old avatar key to delete it (fire-and-forget)
    const current = await this.db.query<{ avatar_key: string | null }[]>(
      `SELECT avatar_key FROM users WHERE id = $1`,
      [userId],
    );
    const oldKey = current[0]?.avatar_key;

    // Update DB
    const rows = returningRows<DbUser>(await this.db.query(
      `UPDATE users SET avatar_key = $1, updated_at = NOW()
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING id, phone, name, language, timezone, avatar_key,
                 is_onboarded, is_verified, is_active, last_active_at, deleted_at`,
      [avatarKey, userId],
    ));

    if (!rows.length) {
      throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'User not found' });
    }

    // Clean up old avatar from R2 (fire-and-forget — don't fail the request)
    if (oldKey && oldKey !== avatarKey) {
      this.storage.deleteObject(oldKey).catch((err: unknown) => {
        this.logger.warn(`Failed to delete old avatar ${oldKey}`, err);
      });
    }

    return this.toProfile(rows[0]);
  }

  // ── Onboarding ─────────────────────────────────────────────────────────────

  async getOnboardingStatus(userId: string): Promise<OnboardingStatus> {
    const rows = await this.db.query<
      { name: string | null; has_connection: boolean }[]
    >(
      `SELECT
         u.name,
         EXISTS(
           SELECT 1 FROM diary_connections
           WHERE (user_a_id = $1 OR user_b_id = $1) AND status = 'active'
         ) AS has_connection
       FROM users u
       WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId],
    );

    if (!rows.length) {
      throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'User not found' });
    }

    const { name, has_connection } = rows[0];
    const profile_complete = name !== null && name.trim().length > 0;

    let step: 'profile' | 'connection' | 'complete';
    if (!profile_complete) {
      step = 'profile';
    } else if (!has_connection) {
      step = 'connection';
    } else {
      step = 'complete';
    }

    return { step, profile_complete, has_connection };
  }

  async completeOnboarding(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET is_onboarded = true, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );

    await this.writeAuditLog(userId, 'user.onboarding_complete', 'user', userId);
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async getSettings(userId: string): Promise<UserSettings> {
    const rows = await this.db.query<
      (Pick<DbUser, 'language' | 'timezone'> & Partial<DbNotifPref>)[]
    >(
      `SELECT
         u.language,
         u.timezone,
         np.new_entry,
         np.flicker_received,
         np.streak_reminder,
         np.streak_reminder_time,
         np.occasion_reminders,
         np.morning_ritual,
         np.morning_ritual_time,
         np.quiet_hours_start,
         np.quiet_hours_end
       FROM users u
       LEFT JOIN notification_preferences np ON np.user_id = u.id
       WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId],
    );

    if (!rows.length) {
      throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'User not found' });
    }

    const row = rows[0];

    // Merge DB values with defaults (handles the case where no notif prefs row exists yet)
    return {
      language: row.language,
      timezone: row.timezone,
      new_entry: row.new_entry ?? NOTIF_DEFAULTS.new_entry,
      flicker_received: row.flicker_received ?? NOTIF_DEFAULTS.flicker_received,
      streak_reminder: row.streak_reminder ?? NOTIF_DEFAULTS.streak_reminder,
      streak_reminder_time: row.streak_reminder_time ?? NOTIF_DEFAULTS.streak_reminder_time,
      occasion_reminders: row.occasion_reminders ?? NOTIF_DEFAULTS.occasion_reminders,
      morning_ritual: row.morning_ritual ?? NOTIF_DEFAULTS.morning_ritual,
      morning_ritual_time: row.morning_ritual_time ?? NOTIF_DEFAULTS.morning_ritual_time,
      quiet_hours_start: row.quiet_hours_start ?? NOTIF_DEFAULTS.quiet_hours_start,
      quiet_hours_end: row.quiet_hours_end ?? NOTIF_DEFAULTS.quiet_hours_end,
    };
  }

  async updateSettings(
    userId: string,
    dto: UpdateSettingsDto,
  ): Promise<UserSettings> {
    // ── 1. Update user fields ──────────────────────────────────────────────
    const userFields: string[] = [];
    const userValues: unknown[] = [];
    let idx = 1;

    if (dto.language !== undefined) {
      userFields.push(`language = $${idx++}`);
      userValues.push(dto.language);
    }
    if (dto.timezone !== undefined) {
      userFields.push(`timezone = $${idx++}`);
      userValues.push(dto.timezone);
    }

    if (userFields.length) {
      userValues.push(userId);
      await this.db.query(
        `UPDATE users SET ${userFields.join(', ')}, updated_at = NOW()
         WHERE id = $${idx} AND deleted_at IS NULL`,
        userValues,
      );
    }

    // ── 2. Upsert notification preferences (only if any pref field provided) ─
    const prefFields = [
      'new_entry', 'flicker_received', 'streak_reminder', 'streak_reminder_time',
      'occasion_reminders', 'morning_ritual', 'morning_ritual_time',
      'quiet_hours_start', 'quiet_hours_end',
    ] as const;

    const hasAnyPref = prefFields.some((f) => dto[f] !== undefined);

    if (hasAnyPref) {
      // Build the UPSERT with only provided fields.
      //  - VALUES: coalesce nulls to the app defaults so a brand-new row
      //    satisfies the NOT NULL columns (a partial PATCH for a user with no
      //    notification_preferences row would otherwise insert NULL and 500).
      //  - ON CONFLICT: coalesce against the *existing* row so an update leaves
      //    fields not present in this PATCH untouched.
      await this.db.query(
        `INSERT INTO notification_preferences (
           user_id, new_entry, flicker_received, streak_reminder,
           streak_reminder_time, occasion_reminders, morning_ritual,
           morning_ritual_time, quiet_hours_start, quiet_hours_end, updated_at
         )
         VALUES (
           $1,
           COALESCE($2, ${NOTIF_DEFAULTS.new_entry}),
           COALESCE($3, ${NOTIF_DEFAULTS.flicker_received}),
           COALESCE($4, ${NOTIF_DEFAULTS.streak_reminder}),
           COALESCE($5, '${NOTIF_DEFAULTS.streak_reminder_time}'::time),
           COALESCE($6, ${NOTIF_DEFAULTS.occasion_reminders}),
           COALESCE($7, ${NOTIF_DEFAULTS.morning_ritual}),
           COALESCE($8, '${NOTIF_DEFAULTS.morning_ritual_time}'::time),
           COALESCE($9, '${NOTIF_DEFAULTS.quiet_hours_start}'::time),
           COALESCE($10, '${NOTIF_DEFAULTS.quiet_hours_end}'::time),
           NOW()
         )
         ON CONFLICT (user_id) DO UPDATE SET
           new_entry            = COALESCE($2, notification_preferences.new_entry),
           flicker_received     = COALESCE($3, notification_preferences.flicker_received),
           streak_reminder      = COALESCE($4, notification_preferences.streak_reminder),
           streak_reminder_time = COALESCE($5, notification_preferences.streak_reminder_time),
           occasion_reminders   = COALESCE($6, notification_preferences.occasion_reminders),
           morning_ritual       = COALESCE($7, notification_preferences.morning_ritual),
           morning_ritual_time  = COALESCE($8, notification_preferences.morning_ritual_time),
           quiet_hours_start    = COALESCE($9, notification_preferences.quiet_hours_start),
           quiet_hours_end      = COALESCE($10, notification_preferences.quiet_hours_end),
           updated_at           = NOW()`,
        [
          userId,
          dto.new_entry ?? null,
          dto.flicker_received ?? null,
          dto.streak_reminder ?? null,
          dto.streak_reminder_time ?? null,
          dto.occasion_reminders ?? null,
          dto.morning_ritual ?? null,
          dto.morning_ritual_time ?? null,
          dto.quiet_hours_start ?? null,
          dto.quiet_hours_end ?? null,
        ],
      );
    }

    return this.getSettings(userId);
  }

  // ── Feature flags ──────────────────────────────────────────────────────────

  async getFeatureFlags(userId: string): Promise<Record<string, boolean>> {
    const flags = await this.db.query<
      { key: string; is_enabled: boolean; rollout_percentage: number }[]
    >(
      `SELECT key, is_enabled, rollout_percentage FROM feature_flags`,
    );

    const result: Record<string, boolean> = {};

    for (const flag of flags) {
      if (!flag.is_enabled) {
        result[flag.key] = false;
        continue;
      }
      if (flag.rollout_percentage >= 100) {
        result[flag.key] = true;
        continue;
      }
      // Deterministic per-user rollout: consistent across requests for the same user
      result[flag.key] = deterministicRollout(userId, flag.key) < flag.rollout_percentage;
    }

    return result;
  }

  // ── Data export (GDPR / DPDP Act compliance) ───────────────────────────────

  async requestDataExport(userId: string): Promise<void> {
    await this.writeAuditLog(userId, 'user.data_export_requested', 'user', userId);

    // TODO (Prompt 09): queue Bull job → 'export_user_data' { userId }
    // The job will compile all entries/transcriptions into a ZIP and
    // send a download notification when ready.
    this.logger.log(`Data export requested for user ${userId} — job queue pending Prompt 09`);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async toProfile(user: DbUser): Promise<UserProfile>;
  private toProfile(user: DbUser): Promise<UserProfile>;

  private async toProfile(user: DbUser): Promise<UserProfile> {
    let avatarUrl: string | null = null;
    if (user.avatar_key) {
      avatarUrl = await this.storage
        .getSignedDownloadUrl(user.avatar_key, 3600)
        .catch(() => null);
    }

    return {
      id: user.id,
      phone: maskPhone(user.phone),
      name: user.name,
      language: user.language,
      timezone: user.timezone,
      avatar_url: avatarUrl,
      is_onboarded: user.is_onboarded,
      is_verified: user.is_verified,
      last_active_at: user.last_active_at,
    };
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
        this.logger.error('Audit log write failed', err);
      });
  }

  // ── Blocks & Reports ───────────────────────────────────────────────────────

  async blockUser(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) {
      throw new BadRequestException({ error: 'CANNOT_BLOCK_SELF', message: 'You cannot block yourself.' });
    }
    await this.db.query(
      `INSERT INTO user_blocks (blocker_id, blocked_id)
       VALUES ($1, $2) ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [blockerId, blockedId],
    );
    await this.writeAuditLog(blockerId, 'user.blocked', 'user', blockedId);
  }

  async unblockUser(blockerId: string, blockedId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [blockerId, blockedId],
    );
    await this.writeAuditLog(blockerId, 'user.unblocked', 'user', blockedId);
  }

  async listBlocks(blockerId: string): Promise<{ blocked: unknown[] }> {
    const rows = await this.db.query(
      `SELECT b.blocked_id, u.name, b.created_at
       FROM user_blocks b JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
      [blockerId],
    );
    return { blocked: rows };
  }

  async reportUser(
    reporterId: string,
    reportedId: string,
    reason: string,
    details: string | null,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO user_reports (reporter_id, reported_id, reason, details)
       VALUES ($1, $2, $3, $4)`,
      [reporterId, reportedId, String(reason).slice(0, 50), details],
    );
    await this.writeAuditLog(reporterId, 'user.reported', 'user', reportedId);
  }
}

// ── Module-level helper ────────────────────────────────────────────────────

/**
 * Deterministic rollout: SHA-256(userId + key) → integer 0–99.
 * Same user always gets the same result for the same flag key.
 * This ensures a user's experience doesn't change between requests.
 */
function deterministicRollout(userId: string, key: string): number {
  const hash = crypto
    .createHash('sha256')
    .update(userId + key)
    .digest('hex');
  // Take first 8 hex chars → 32-bit number → mod 100
  return parseInt(hash.slice(0, 8), 16) % 100;
}
