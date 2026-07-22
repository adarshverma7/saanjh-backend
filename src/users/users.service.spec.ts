import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { DataExportService } from './data-export.service';
import { StorageService } from '../shared/storage/storage.service';

const USER_ID = 'user-uuid-001';

function makeDbUser(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    phone: '+919876543210',
    name: 'Adarsh',
    language: 'en',
    timezone: 'Asia/Kolkata',
    avatar_key: null,
    is_onboarded: false,
    is_verified: true,
    is_active: true,
    last_active_at: null,
    deleted_at: null,
    ...overrides,
  };
}

describe('UsersService', () => {
  let service: UsersService;
  let mockDb: { query: jest.Mock };
  let mockStorage: Partial<StorageService>;
  let mockDataExport: { generateExport: jest.Mock };

  beforeEach(async () => {
    mockDb = { query: jest.fn() };
    mockStorage = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://signed-url.example.com'),
      getSignedUploadUrl: jest.fn().mockResolvedValue('https://upload-url.example.com'),
      objectExists: jest.fn().mockResolvedValue(true),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    mockDataExport = { generateExport: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getDataSourceToken(), useValue: mockDb },
        { provide: StorageService, useValue: mockStorage },
        { provide: DataExportService, useValue: mockDataExport },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── getProfile ─────────────────────────────────────────────────────────────

  describe('getProfile', () => {
    it('returns masked phone and generates signed avatar URL when key exists', async () => {
      const user = makeDbUser({ avatar_key: 'avatars/user-001/123.jpg' });
      mockDb.query.mockResolvedValueOnce([user]);

      const profile = await service.getProfile(USER_ID);

      expect(profile.phone).not.toBe('+919876543210');
      expect(profile.phone).toContain('X');
      expect(profile.avatar_url).toBe('https://signed-url.example.com');
      expect(mockStorage.getSignedDownloadUrl).toHaveBeenCalledWith(
        'avatars/user-001/123.jpg',
        3600,
      );
    });

    it('returns null avatar_url when no avatar_key is set', async () => {
      mockDb.query.mockResolvedValueOnce([makeDbUser({ avatar_key: null })]);

      const profile = await service.getProfile(USER_ID);

      expect(profile.avatar_url).toBeNull();
      expect(mockStorage.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when user not found', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await expect(service.getProfile(USER_ID)).rejects.toThrow(NotFoundException);
    });
  });

  // ── updateProfile ──────────────────────────────────────────────────────────

  describe('updateProfile', () => {
    it('skips DB update and returns current profile when no fields provided', async () => {
      mockDb.query.mockResolvedValueOnce([makeDbUser()]);

      await service.updateProfile(USER_ID, {});

      // Only the getProfile SELECT should run, not an UPDATE
      const [sql] = mockDb.query.mock.calls[0] as [string];
      expect(sql).toContain('SELECT');
      expect(sql).not.toContain('UPDATE');
    });

    it('builds dynamic UPDATE with only provided fields', async () => {
      mockDb.query.mockResolvedValueOnce([makeDbUser({ name: 'NewName' })]);

      await service.updateProfile(USER_ID, { name: 'NewName' });

      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('UPDATE users');
      expect(sql).toContain('name =');
      expect(sql).not.toContain('language =');
      expect(params).toContain('NewName');
    });

    it('trims whitespace from name', async () => {
      mockDb.query.mockResolvedValueOnce([makeDbUser({ name: 'Adarsh' })]);

      await service.updateProfile(USER_ID, { name: '  Adarsh  ' });

      const params = mockDb.query.mock.calls[0][1] as unknown[];
      expect(params).toContain('Adarsh');
      expect(params).not.toContain('  Adarsh  ');
    });
  });

  // ── updateAvatar ───────────────────────────────────────────────────────────

  describe('updateAvatar', () => {
    it('rejects avatar key that does not belong to this user', async () => {
      await expect(
        service.updateAvatar(USER_ID, `avatars/other-user/123.jpg`),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws AVATAR_NOT_UPLOADED when R2 object does not exist', async () => {
      (mockStorage.objectExists as jest.Mock).mockResolvedValueOnce(false);

      await expect(
        service.updateAvatar(USER_ID, `avatars/${USER_ID}/123.jpg`),
      ).rejects.toThrow(BadRequestException);
    });

    it('deletes old avatar when a new one is set', async () => {
      const oldKey = `avatars/${USER_ID}/old.jpg`;
      const newKey = `avatars/${USER_ID}/new.jpg`;

      // objectExists → true
      (mockStorage.objectExists as jest.Mock).mockResolvedValueOnce(true);
      // SELECT old avatar_key
      mockDb.query.mockResolvedValueOnce([{ avatar_key: oldKey }]);
      // UPDATE RETURNING
      mockDb.query.mockResolvedValueOnce([makeDbUser({ avatar_key: newKey })]);

      await service.updateAvatar(USER_ID, newKey);

      // Give the fire-and-forget a tick to run
      await new Promise((r) => setImmediate(r));

      expect(mockStorage.deleteObject).toHaveBeenCalledWith(oldKey);
    });
  });

  // ── getOnboardingStatus ────────────────────────────────────────────────────

  describe('getOnboardingStatus', () => {
    it("returns step='profile' when name is null", async () => {
      mockDb.query.mockResolvedValueOnce([{ name: null, has_connection: false }]);

      const status = await service.getOnboardingStatus(USER_ID);

      expect(status.step).toBe('profile');
      expect(status.profile_complete).toBe(false);
    });

    it("returns step='connection' when name is set but no active connection", async () => {
      mockDb.query.mockResolvedValueOnce([
        { name: 'Adarsh', has_connection: false },
      ]);

      const status = await service.getOnboardingStatus(USER_ID);

      expect(status.step).toBe('connection');
      expect(status.profile_complete).toBe(true);
      expect(status.has_connection).toBe(false);
    });

    it("returns step='complete' when name set and has active connection", async () => {
      mockDb.query.mockResolvedValueOnce([
        { name: 'Adarsh', has_connection: true },
      ]);

      const status = await service.getOnboardingStatus(USER_ID);

      expect(status.step).toBe('complete');
      expect(status.has_connection).toBe(true);
    });
  });

  // ── getSettings ────────────────────────────────────────────────────────────

  describe('getSettings', () => {
    it('fills defaults when notification_preferences row does not exist', async () => {
      mockDb.query.mockResolvedValueOnce([
        { language: 'en', timezone: 'Asia/Kolkata' },
        // no notification pref columns — they come back as undefined
      ]);

      const settings = await service.getSettings(USER_ID);

      expect(settings.new_entry).toBe(true);
      expect(settings.streak_reminder_time).toBe('20:00:00');
      expect(settings.quiet_hours_start).toBe('22:00:00');
    });

    it('uses DB values when notification_preferences row exists', async () => {
      mockDb.query.mockResolvedValueOnce([
        {
          language: 'hi',
          timezone: 'Asia/Kolkata',
          new_entry: false,
          flicker_received: true,
          streak_reminder: false,
          streak_reminder_time: '19:00:00',
          occasion_reminders: true,
          morning_ritual: false,
          morning_ritual_time: '09:00:00',
          quiet_hours_start: '23:00:00',
          quiet_hours_end: '06:00:00',
        },
      ]);

      const settings = await service.getSettings(USER_ID);

      expect(settings.language).toBe('hi');
      expect(settings.new_entry).toBe(false);
      expect(settings.streak_reminder).toBe(false);
      expect(settings.streak_reminder_time).toBe('19:00:00');
    });
  });

  // ── updateSettings ───────────────────────────────────────────────────────

  describe('updateSettings', () => {
    const settingsRow = [
      {
        language: 'en', timezone: 'Asia/Kolkata',
        new_entry: false, flicker_received: true, streak_reminder: true,
        streak_reminder_time: '20:00:00', occasion_reminders: true,
        morning_ritual: true, morning_ritual_time: '08:00:00',
        quiet_hours_start: '22:00:00', quiet_hours_end: '07:00:00',
      },
    ];

    it('coalesces INSERT defaults so a partial PATCH for a user with no prefs row cannot insert NULL into NOT NULL columns', async () => {
      // 1st query = the upsert, 2nd = getSettings SELECT
      mockDb.query.mockResolvedValueOnce([]).mockResolvedValueOnce(settingsRow);

      await service.updateSettings(USER_ID, { new_entry: false });

      const upsertSql = mockDb.query.mock.calls[0][0] as string;
      const upsertParams = mockDb.query.mock.calls[0][1] as unknown[];

      // Regression (PATCH /settings 500): every NOT NULL column must fall back
      // to a default in VALUES rather than be inserted as raw NULL.
      expect(upsertSql).toContain('COALESCE($3, true)'); // flicker_received default
      expect(upsertSql).toContain("COALESCE($5, '20:00:00'::time)"); // streak_reminder_time
      // Unspecified fields are still passed as null — COALESCE handles them.
      expect(upsertParams[1]).toBe(false); // $2 new_entry (provided)
      expect(upsertParams[2]).toBeNull();  // $3 flicker_received (not provided)
    });

    it('skips the users UPDATE when only notification prefs are provided', async () => {
      mockDb.query.mockResolvedValueOnce([]).mockResolvedValueOnce(settingsRow);
      await service.updateSettings(USER_ID, { occasion_reminders: false });
      // Only two queries run: the upsert and the getSettings read-back.
      expect(mockDb.query).toHaveBeenCalledTimes(2);
      expect(mockDb.query.mock.calls[0][0]).toContain('INSERT INTO notification_preferences');
    });

    it('updates the users table (not the prefs upsert) when only language changes', async () => {
      mockDb.query.mockResolvedValueOnce([]).mockResolvedValueOnce(settingsRow);
      await service.updateSettings(USER_ID, { language: 'hi' });
      expect(mockDb.query).toHaveBeenCalledTimes(2); // users UPDATE + getSettings
      expect(mockDb.query.mock.calls[0][0]).toContain('UPDATE users');
    });
  });

  // ── requestDataExport ──────────────────────────────────────────────────────

  describe('requestDataExport', () => {
    it('writes an audit log and kicks off background export generation', async () => {
      mockDb.query.mockResolvedValue([]);

      await service.requestDataExport(USER_ID);

      // Audit log written for the request itself
      const auditCall = mockDb.query.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('audit_logs'),
      );
      expect(auditCall).toBeDefined();
      // Background generation triggered (fire-and-forget) with the user id
      expect(mockDataExport.generateExport).toHaveBeenCalledWith(USER_ID);
    });

    it('does not throw if background export generation rejects', async () => {
      mockDb.query.mockResolvedValue([]);
      mockDataExport.generateExport.mockRejectedValueOnce(new Error('storage down'));

      await expect(service.requestDataExport(USER_ID)).resolves.toBeUndefined();
    });
  });

  // ── getFeatureFlags ────────────────────────────────────────────────────────

  describe('getFeatureFlags', () => {
    it('returns false for disabled flags regardless of rollout', async () => {
      mockDb.query.mockResolvedValueOnce([
        { key: 'video_entries', is_enabled: false, rollout_percentage: 100 },
      ]);

      const flags = await service.getFeatureFlags(USER_ID);

      expect(flags['video_entries']).toBe(false);
    });

    it('returns true for 100% rollout enabled flags', async () => {
      mockDb.query.mockResolvedValueOnce([
        { key: 'transcription', is_enabled: true, rollout_percentage: 100 },
      ]);

      const flags = await service.getFeatureFlags(USER_ID);

      expect(flags['transcription']).toBe(true);
    });

    it('deterministic rollout returns consistent result for same user+key', async () => {
      // Run twice — must return same value both times
      mockDb.query
        .mockResolvedValueOnce([
          { key: 'occasion_ai', is_enabled: true, rollout_percentage: 50 },
        ])
        .mockResolvedValueOnce([
          { key: 'occasion_ai', is_enabled: true, rollout_percentage: 50 },
        ]);

      const flags1 = await service.getFeatureFlags(USER_ID);
      const flags2 = await service.getFeatureFlags(USER_ID);

      expect(flags1['occasion_ai']).toBe(flags2['occasion_ai']);
    });

    it('different users can get different results for partial rollout', async () => {
      const flags: Record<string, boolean> = {};

      // Test 20 different user IDs — at 50% rollout we expect some true and some false
      for (let i = 0; i < 20; i++) {
        mockDb.query.mockResolvedValueOnce([
          { key: 'test_flag', is_enabled: true, rollout_percentage: 50 },
        ]);
        const result = await service.getFeatureFlags(`user-${i}`);
        flags[`user-${i}`] = result['test_flag'];
      }

      const trueCount = Object.values(flags).filter(Boolean).length;
      // At 50%, we expect roughly 10 true — allow 2–18 range for randomness
      expect(trueCount).toBeGreaterThanOrEqual(2);
      expect(trueCount).toBeLessThanOrEqual(18);
    });
  });
});
