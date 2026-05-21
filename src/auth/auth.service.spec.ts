import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TooManyRequestsException } from '../shared/exceptions/too-many-requests.exception';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getDataSourceToken } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { FirebaseService } from './firebase.service';
import { hashOtp, hashRefreshToken } from '../shared/helpers/phone.helper';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const PHONE = '+919876543210';
const DEVICE_INFO = { device_id: 'device-abc', device_type: 'android' as const };
const USER_ID = 'user-uuid-123';
const SESSION_ID = 'session-uuid-456';

function makeOtp(otp: string) {
  return {
    id: 'otp-uuid-789',
    otp_hash: hashOtp(otp),
    attempt_count: 0,
    expires_at: new Date(Date.now() + 600_000),
  };
}

function makeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: USER_ID,
    phone: PHONE,
    name: null,
    language: 'en',
    timezone: 'Asia/Kolkata',
    is_onboarded: false,
    is_verified: true,
    is_active: true,
    deleted_at: null,
    ...overrides,
  };
}

// ── Mock DataSource factory ───────────────────────────────────────────────────

function buildMockDb(
  queryResults: Record<string, unknown[][]> = {},
  defaultResult: unknown[] = [],
) {
  let callIndex = 0;
  const results = Object.values(queryResults);

  return {
    query: jest.fn().mockImplementation(() => {
      const result = results[callIndex] ?? defaultResult;
      callIndex++;
      return Promise.resolve(result);
    }),
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  let service: AuthService;
  let mockDb: { query: jest.Mock };
  let mockConfig: Partial<ConfigService>;
  let mockJwt: Partial<JwtService>;

  beforeEach(async () => {
    mockDb = { query: jest.fn() };

    mockConfig = {
      get: jest.fn().mockImplementation((key: string) => {
        const map: Record<string, string> = {
          nodeEnv: 'test',
          phoneHashSalt: 'test-salt-32-chars-minimum-here!!',
          'jwt.privateKey': 'test-private-key',
          'msg91.authKey': '',
        };
        return map[key];
      }),
    };

    mockJwt = {
      sign: jest.fn().mockReturnValue('mock.access.token'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getDataSourceToken(), useValue: mockDb },
        { provide: ConfigService, useValue: mockConfig },
        { provide: JwtService, useValue: mockJwt },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: FirebaseService, useValue: { verifyIdToken: jest.fn() } },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── sendOtp ────────────────────────────────────────────────────────────────

  describe('sendOtp', () => {
    it('succeeds on first call (rate limit counter = 1)', async () => {
      // Rate limit UPSERT returns count=1, then invalidate, then insert OTP
      mockDb.query
        .mockResolvedValueOnce([{ count: '1' }])  // phone rate limit
        .mockResolvedValueOnce([{ count: '1' }])  // IP rate limit
        .mockResolvedValueOnce([])                 // invalidate old OTPs
        .mockResolvedValueOnce([]);                // insert new OTP

      await expect(service.sendOtp(PHONE, '1.2.3.4')).resolves.not.toThrow();
      expect(mockDb.query).toHaveBeenCalledTimes(4);
    });

    it('throws TooManyRequestsException when phone rate limit exceeded', async () => {
      // count=4 > max=3 → rate limit exceeded
      mockDb.query.mockResolvedValueOnce([{ count: '4' }]);

      await expect(service.sendOtp(PHONE, '1.2.3.4')).rejects.toThrow(
        TooManyRequestsException,
      );
    });

    it('throws TooManyRequestsException when IP rate limit exceeded', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ count: '1' }])   // phone ok
        .mockResolvedValueOnce([{ count: '16' }]);  // IP over limit

      await expect(service.sendOtp(PHONE, '1.2.3.4')).rejects.toThrow(
        TooManyRequestsException,
      );
    });
  });

  // ── verifyOtp ──────────────────────────────────────────────────────────────

  describe('verifyOtp', () => {
    it('returns tokens and profile on correct OTP (existing user)', async () => {
      const otp = '123456';
      const otpRecord = makeOtp(otp);
      const user = makeUser();

      mockDb.query
        .mockResolvedValueOnce([otpRecord])          // find OTP
        .mockResolvedValueOnce([])                   // mark OTP used
        .mockResolvedValueOnce([user])               // find existing user
        .mockResolvedValueOnce([{ id: SESSION_ID }]) // upsert device session
        .mockResolvedValueOnce([])                   // deactivate excess sessions
        .mockResolvedValueOnce([]);                  // store refresh token hash

      const result = await service.verifyOtp(PHONE, otp, DEVICE_INFO);

      expect(result.access_token).toBe('mock.access.token');
      expect(result.refresh_token).toHaveLength(128); // 64 bytes hex
      expect(result.is_new_user).toBe(false);
      expect(result.user.id).toBe(USER_ID);
      // Phone must be masked in response
      expect(result.user.phone).not.toBe(PHONE);
      expect(result.user.phone).toContain('X');
    });

    it('creates new user when phone not registered', async () => {
      const otp = '654321';
      const otpRecord = makeOtp(otp);
      const newUser = makeUser({ is_onboarded: false });

      mockDb.query
        .mockResolvedValueOnce([otpRecord])          // find OTP
        .mockResolvedValueOnce([])                   // mark OTP used
        .mockResolvedValueOnce([])                   // no existing user
        .mockResolvedValueOnce([newUser])            // insert new user
        .mockResolvedValueOnce([])                   // audit log
        .mockResolvedValueOnce([{ id: SESSION_ID }]) // upsert session
        .mockResolvedValueOnce([])                   // deactivate excess
        .mockResolvedValueOnce([]);                  // store refresh hash

      const result = await service.verifyOtp(PHONE, otp, DEVICE_INFO);
      expect(result.is_new_user).toBe(true);
    });

    it('throws OTP_EXPIRED with correct code when no valid OTP exists', async () => {
      mockDb.query.mockResolvedValueOnce([]); // empty result — no OTP found

      let caughtError: UnauthorizedException | null = null;
      await service
        .verifyOtp(PHONE, '000000', DEVICE_INFO)
        .catch((e: UnauthorizedException) => { caughtError = e; });

      expect(caughtError).toBeInstanceOf(UnauthorizedException);
      const body = (caughtError as unknown as UnauthorizedException).getResponse() as { error: string };
      expect(body.error).toBe('OTP_EXPIRED');
    });

    it('throws TOO_MANY_ATTEMPTS when attempt_count >= 5', async () => {
      const exhaustedRecord = { ...makeOtp('123456'), attempt_count: 5 };
      mockDb.query.mockResolvedValueOnce([exhaustedRecord]);

      await expect(
        service.verifyOtp(PHONE, '123456', DEVICE_INFO),
      ).rejects.toThrow(TooManyRequestsException);
    });

    it('increments attempt_count and throws INVALID_OTP on wrong OTP', async () => {
      const correctOtp = '111111';
      const otpRecord = makeOtp(correctOtp);
      mockDb.query
        .mockResolvedValueOnce([otpRecord]) // find OTP
        .mockResolvedValueOnce([]);         // increment attempt_count

      await expect(
        service.verifyOtp(PHONE, '999999', DEVICE_INFO),
      ).rejects.toThrow(UnauthorizedException);

      // Verify attempt_count increment was called
      const incrementCall = mockDb.query.mock.calls[1] as [string, unknown[]];
      expect(incrementCall[0]).toContain('attempt_count + 1');
    });

    it('throws ACCOUNT_DELETED for soft-deleted users', async () => {
      const otp = '777777';
      const otpRecord = makeOtp(otp);
      const deletedUser = makeUser({ deleted_at: new Date() });

      mockDb.query
        .mockResolvedValueOnce([otpRecord])  // find OTP
        .mockResolvedValueOnce([])           // mark used
        .mockResolvedValueOnce([deletedUser]); // find user

      await expect(
        service.verifyOtp(PHONE, otp, DEVICE_INFO),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── refreshToken ───────────────────────────────────────────────────────────

  describe('refreshToken', () => {
    it('rotates refresh token: issues new tokens, invalidates old hash', async () => {
      const oldRefreshToken = 'a'.repeat(128);
      const existingSession = {
        id: SESSION_ID,
        user_id: USER_ID,
        device_id: DEVICE_INFO.device_id,
        is_active: true,
      };

      mockDb.query
        .mockResolvedValueOnce([existingSession]) // find session by hash
        .mockResolvedValueOnce([]);               // update with new hash

      const result = await service.refreshToken(
        oldRefreshToken,
        DEVICE_INFO.device_id,
      );

      expect(result.access_token).toBe('mock.access.token');
      expect(result.refresh_token).toHaveLength(128);
      // New token must differ from old
      expect(result.refresh_token).not.toBe(oldRefreshToken);

      // Confirm the DB was updated with the NEW hash (rotation)
      const updateCall = mockDb.query.mock.calls[1] as [string, unknown[]];
      expect(updateCall[0]).toContain('refresh_token_hash');
      // The stored hash must be the SHA-256 of the NEW token
      expect(updateCall[1][0]).toBe(hashRefreshToken(result.refresh_token));
    });

    it('throws INVALID_TOKEN when session not found', async () => {
      mockDb.query.mockResolvedValueOnce([]); // no session found

      await expect(
        service.refreshToken('bad-token', DEVICE_INFO.device_id),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('old refresh token is invalidated after rotation', async () => {
      const oldToken = 'b'.repeat(128);
      const oldHash = hashRefreshToken(oldToken);
      const session = {
        id: SESSION_ID,
        user_id: USER_ID,
        device_id: DEVICE_INFO.device_id,
        is_active: true,
      };

      mockDb.query
        .mockResolvedValueOnce([session])
        .mockResolvedValueOnce([]);

      const { refresh_token: newToken } = await service.refreshToken(
        oldToken,
        DEVICE_INFO.device_id,
      );

      const newHash = hashRefreshToken(newToken);

      // The update call stores the NEW hash, not the old one
      const updateArgs = mockDb.query.mock.calls[1][1] as string[];
      expect(updateArgs[0]).toBe(newHash);
      expect(updateArgs[0]).not.toBe(oldHash);
    });
  });

  // ── logout ─────────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('deactivates session and clears refresh token hash', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await expect(
        service.logout(USER_ID, DEVICE_INFO.device_id),
      ).resolves.not.toThrow();

      const [sql, params] = mockDb.query.mock.calls[0] as [string, string[]];
      expect(sql).toContain('is_active = false');
      expect(sql).toContain('refresh_token_hash = NULL');
      expect(params).toContain(USER_ID);
      expect(params).toContain(DEVICE_INFO.device_id);
    });
  });
});
