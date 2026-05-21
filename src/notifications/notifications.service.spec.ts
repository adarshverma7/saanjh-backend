import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { NotificationsService, isInQuietHours } from './notifications.service';

const USER_A = 'user-a-uuid';
const DEVICE_ID = 'device-001';

// Matches actual notification_preferences DB columns
const DEFAULT_PREFS = {
  new_entry: true,
  flicker_received: true,
  streak_reminder: true,
  occasion_reminders: true,
  morning_ritual: true,
  quiet_hours_start: '22:00:00',
  quiet_hours_end: '08:00:00',
};

describe('NotificationsService', () => {
  let service: NotificationsService;
  let mockDb: { query: jest.Mock };
  let mockConfig: { get: jest.Mock };

  beforeEach(async () => {
    mockDb = { query: jest.fn() };
    mockConfig = { get: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: getDataSourceToken(), useValue: mockDb },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── processTemplate ─────────────────────────────────────────────────────────

  describe('processTemplate', () => {
    it('replaces {{variables}} with values', () => {
      expect(
        service.processTemplate('Hello {{name}}, streak={{count}}', { name: 'Priya', count: '7' }),
      ).toBe('Hello Priya, streak=7');
    });

    it('leaves unknown placeholders empty', () => {
      expect(service.processTemplate('Hi {{unknown}}', {})).toBe('Hi ');
    });
  });

  // ── renderTemplate ──────────────────────────────────────────────────────────

  describe('renderTemplate', () => {
    it('renders new_entry template', () => {
      const { title, body } = service.renderTemplate('new_entry', {
        partner_name: 'Aarav',
        duration: '45',
      });
      expect(title).toBe('Aarav left you a voice note');
      expect(body).toBe('45s — tap to listen');
    });

    it('renders streak_reminder template', () => {
      const { title, body } = service.renderTemplate('streak_reminder', {
        streak_count: '14',
        partner_name: 'Aarav',
      });
      expect(title).toBe('Your streak is at risk');
      expect(body).toBe("14 days with Aarav — don't break it");
    });

    it('renders milestone template', () => {
      const { title, body } = service.renderTemplate('milestone', {
        streak_count: '30',
        partner_name: 'Priya',
      });
      expect(title).toBe('30 days together');
      expect(body).toBe('You and Priya hit a milestone');
    });

    it('renders occasion template', () => {
      const { title, body } = service.renderTemplate('occasion', {
        occasion_name: "Priya's Birthday",
        days_away: '3',
        partner_name: 'Priya',
      });
      expect(title).toBe("Priya's Birthday is in 3 days");
      expect(body).toBe('Record something special for Priya');
    });

    it('renders mutual_flicker template using flicker_received preference', () => {
      const { title, body } = service.renderTemplate('mutual_flicker', {
        partner_name: 'Aarav',
      });
      expect(title).toBe('You and Aarav flickered each other ♥');
      expect(body).toBe('A little moment, shared.');
    });
  });

  // ── createNotification ──────────────────────────────────────────────────────

  describe('createNotification', () => {
    it('inserts notification, checks prefs, sends push when allowed', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ id: 'notif-001' }])    // INSERT notification
        .mockResolvedValueOnce([DEFAULT_PREFS])            // getPreferences
        .mockResolvedValueOnce([]);                        // UPDATE push_status

      jest.spyOn(service, 'sendPush').mockResolvedValueOnce(true);

      await service.createNotification(USER_A, 'new_entry', 'Title', 'Body', {});

      expect(mockDb.query.mock.calls[0][0]).toContain('INSERT INTO notifications');
      expect(mockDb.query.mock.calls[1][0]).toContain('notification_preferences');
    });

    it('skips push when preference for type is false', async () => {
      const disabledPrefs = { ...DEFAULT_PREFS, new_entry: false };
      mockDb.query
        .mockResolvedValueOnce([{ id: 'notif-002' }])
        .mockResolvedValueOnce([disabledPrefs])
        .mockResolvedValueOnce([]); // UPDATE push_status = skipped

      const pushSpy = jest.spyOn(service, 'sendPush');

      await service.createNotification(USER_A, 'new_entry', 'T', 'B', {});

      expect(pushSpy).not.toHaveBeenCalled();
    });

    it('maps mutual_flicker to flicker_received preference', async () => {
      const noFlicker = { ...DEFAULT_PREFS, flicker_received: false };
      mockDb.query
        .mockResolvedValueOnce([{ id: 'notif-003' }])
        .mockResolvedValueOnce([noFlicker])
        .mockResolvedValueOnce([]);

      const pushSpy = jest.spyOn(service, 'sendPush');
      await service.createNotification(USER_A, 'mutual_flicker', 'T', 'B', {});
      expect(pushSpy).not.toHaveBeenCalled();
    });

    it('maps milestone to streak_reminder preference', async () => {
      const noStreak = { ...DEFAULT_PREFS, streak_reminder: false };
      mockDb.query
        .mockResolvedValueOnce([{ id: 'notif-004' }])
        .mockResolvedValueOnce([noStreak])
        .mockResolvedValueOnce([]);

      const pushSpy = jest.spyOn(service, 'sendPush');
      await service.createNotification(USER_A, 'milestone', 'T', 'B', {});
      expect(pushSpy).not.toHaveBeenCalled();
    });

    it('does not throw when INSERT notification fails', async () => {
      // INSERT fails — service catches and continues to check prefs
      mockDb.query
        .mockRejectedValueOnce(new Error('DB down'))
        .mockResolvedValueOnce([DEFAULT_PREFS]);

      jest.spyOn(service, 'sendPush').mockResolvedValueOnce(false);

      await expect(
        service.createNotification(USER_A, 'new_entry', 'T', 'B', {}),
      ).resolves.not.toThrow();
    });
  });

  // ── sendPush ─────────────────────────────────────────────────────────────────

  describe('sendPush', () => {
    it('returns false when OneSignal not configured', async () => {
      mockConfig.get.mockReturnValue(undefined);
      const result = await service.sendPush([USER_A], 'T', 'B', {});
      expect(result).toBe(false);
    });

    it('returns false when no active FCM tokens found', async () => {
      mockConfig.get.mockReturnValue('app-id');
      mockDb.query.mockResolvedValueOnce([]); // no tokens

      const result = await service.sendPush([USER_A], 'T', 'B', {});
      expect(result).toBe(false);
    });
  });

  // ── getNotifications ────────────────────────────────────────────────────────

  describe('getNotifications', () => {
    it('returns items with next_cursor when more results exist', async () => {
      const rows = Array.from({ length: 21 }, (_, i) => ({
        id: `notif-${i}`,
        user_id: USER_A,
        type: 'new_entry',
        title: 'T',
        body: 'B',
        data: null,
        is_read: false,
        read_at: null,
        push_status: 'sent',
        created_at: new Date('2026-05-20T12:00:00Z'),
      }));

      mockDb.query.mockResolvedValueOnce(rows);

      const result = await service.getNotifications(USER_A, 'all', 20);
      expect(result.items).toHaveLength(20);
      expect(result.next_cursor).not.toBeNull();
    });

    it('returns null next_cursor when no more results', async () => {
      mockDb.query.mockResolvedValueOnce([{
        id: 'notif-0',
        user_id: USER_A,
        type: 'new_entry',
        title: 'T',
        body: 'B',
        data: null,
        is_read: false,
        read_at: null,
        push_status: 'sent',
        created_at: new Date('2026-05-20T12:00:00Z'),
      }]);

      const result = await service.getNotifications(USER_A, 'all', 20);
      expect(result.items).toHaveLength(1);
      expect(result.next_cursor).toBeNull();
    });
  });

  // ── markAsRead ──────────────────────────────────────────────────────────────

  describe('markAsRead', () => {
    it('issues UPDATE with id array and user_id', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await service.markAsRead(USER_A, ['id-1', 'id-2']);

      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('UPDATE notifications');
      expect(sql).toContain('is_read = true');
      expect(params[0]).toEqual(['id-1', 'id-2']);
      expect(params[1]).toBe(USER_A);
    });
  });

  // ── getPreferences ──────────────────────────────────────────────────────────

  describe('getPreferences', () => {
    it('returns DB row when preference exists', async () => {
      mockDb.query.mockResolvedValueOnce([DEFAULT_PREFS]);

      const result = await service.getPreferences(USER_A);
      expect(result.streak_reminder).toBe(true);
      expect(result.occasion_reminders).toBe(true);
    });

    it('returns defaults when no preference row exists', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      const result = await service.getPreferences(USER_A);
      expect(result.new_entry).toBe(true);
      expect(result.quiet_hours_start).toBe('22:00:00');
    });
  });

  // ── updatePreferences ───────────────────────────────────────────────────────

  describe('updatePreferences', () => {
    it('upserts and returns updated preferences', async () => {
      mockDb.query
        .mockResolvedValueOnce([])  // INSERT ON CONFLICT DO NOTHING
        .mockResolvedValueOnce([])  // UPDATE SET
        .mockResolvedValueOnce([{ ...DEFAULT_PREFS, streak_reminder: false }]);

      const result = await service.updatePreferences(USER_A, { streak_reminder: false });

      expect(result.streak_reminder).toBe(false);
    });

    it('returns current prefs unchanged when no fields provided', async () => {
      mockDb.query.mockResolvedValueOnce([DEFAULT_PREFS]);

      const result = await service.updatePreferences(USER_A, {});
      expect(result).toEqual(DEFAULT_PREFS);
    });
  });

  // ── registerDeviceToken ─────────────────────────────────────────────────────

  describe('registerDeviceToken', () => {
    it('issues upsert with correct ON CONFLICT clause', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await service.registerDeviceToken(USER_A, {
        device_id: DEVICE_ID,
        fcm_token: 'fcm-abc',
        app_version: '1.2.3',
      });

      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('ON CONFLICT (user_id, device_id)');
      expect(sql).toContain('DO UPDATE SET');
      expect(params[0]).toBe(USER_A);
      expect(params[1]).toBe(DEVICE_ID);
      expect(params[2]).toBe('fcm-abc');
    });
  });
});

// ── isInQuietHours pure function tests ────────────────────────────────────────

describe('isInQuietHours', () => {
  it('returns true when time is within same-day window (22:00–23:00)', () => {
    expect(isInQuietHours('22:30', '22:00', '23:00')).toBe(true);
  });

  it('returns false when time is outside same-day window', () => {
    expect(isInQuietHours('21:00', '22:00', '23:00')).toBe(false);
  });

  it('returns true for overnight window — time after start', () => {
    expect(isInQuietHours('23:00', '22:00', '08:00')).toBe(true);
  });

  it('returns true for overnight window — time before end', () => {
    expect(isInQuietHours('07:00', '22:00', '08:00')).toBe(true);
  });

  it('returns false for overnight window — time in the middle of day', () => {
    expect(isInQuietHours('14:00', '22:00', '08:00')).toBe(false);
  });

  it('returns false exactly at end time (exclusive upper bound)', () => {
    expect(isInQuietHours('08:00', '22:00', '08:00')).toBe(false);
  });
});
