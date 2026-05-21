import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { NotificationCronService } from './notification-cron.service';
import { NotificationsService } from './notifications.service';

const CONN_ID = 'conn-uuid-001';
const USER_A = 'user-a-uuid';
const USER_B = 'user-b-uuid';

describe('NotificationCronService', () => {
  let service: NotificationCronService;
  let mockDb: { query: jest.Mock };
  let mockNotificationsService: {
    createNotification: jest.Mock;
    renderTemplate: jest.Mock;
  };

  beforeEach(async () => {
    mockDb = { query: jest.fn() };
    mockNotificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
      renderTemplate: jest.fn().mockReturnValue({ title: 'T', body: 'B' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationCronService,
        { provide: getDataSourceToken(), useValue: mockDb },
        { provide: NotificationsService, useValue: mockNotificationsService },
      ],
    }).compile();

    service = module.get<NotificationCronService>(NotificationCronService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── sendStreakReminders ────────────────────────────────────────────────────

  describe('sendStreakReminders', () => {
    it('sends reminder to both users of each at-risk connection', async () => {
      mockDb.query.mockResolvedValueOnce([
        {
          id: CONN_ID,
          user_a_id: USER_A,
          user_b_id: USER_B,
          streak_count: 7,
          name_for_a: 'Priya',
          name_for_b: 'Aarav',
        },
      ]);

      await service.sendStreakReminders();

      expect(mockNotificationsService.renderTemplate).toHaveBeenCalledTimes(2);
      expect(mockNotificationsService.createNotification).toHaveBeenCalledTimes(2);
    });

    it('uses partner name from name_for_b for user_a notification', async () => {
      mockDb.query.mockResolvedValueOnce([
        {
          id: CONN_ID,
          user_a_id: USER_A,
          user_b_id: USER_B,
          streak_count: 14,
          name_for_a: 'Priya',
          name_for_b: 'Aarav',
        },
      ]);

      await service.sendStreakReminders();

      // First renderTemplate call is for user_a, should use name_for_b (Aarav) as partner
      expect(mockNotificationsService.renderTemplate).toHaveBeenNthCalledWith(
        1,
        'streak_reminder',
        expect.objectContaining({ partner_name: 'Aarav', streak_count: '14' }),
      );
    });

    it('falls back to "your partner" when name is null', async () => {
      mockDb.query.mockResolvedValueOnce([
        {
          id: CONN_ID,
          user_a_id: USER_A,
          user_b_id: USER_B,
          streak_count: 5,
          name_for_a: null,
          name_for_b: null,
        },
      ]);

      await service.sendStreakReminders();

      expect(mockNotificationsService.renderTemplate).toHaveBeenCalledWith(
        'streak_reminder',
        expect.objectContaining({ partner_name: 'your partner' }),
      );
    });

    it('does nothing when no at-risk connections found', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await service.sendStreakReminders();

      expect(mockNotificationsService.createNotification).not.toHaveBeenCalled();
    });

    it('does not throw when DB query fails', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('DB error'));

      await expect(service.sendStreakReminders()).resolves.not.toThrow();
    });
  });

  // ── sendOccasionReminders ──────────────────────────────────────────────────

  describe('sendOccasionReminders', () => {
    it('sends occasion reminder to both users and updates last_reminded_year', async () => {
      mockDb.query
        .mockResolvedValueOnce([
          {
            id: 'occ-001',
            connection_id: CONN_ID,
            occasion_name: "Priya's Birthday",
            occasion_date: '2026-05-25',
            remind_days_before: 5,
            user_a_id: USER_A,
            user_b_id: USER_B,
            name_for_a: 'Priya',
            name_for_b: 'Aarav',
          },
        ])
        .mockResolvedValueOnce([]); // UPDATE last_reminded_year

      await service.sendOccasionReminders();

      expect(mockNotificationsService.createNotification).toHaveBeenCalledTimes(2);

      const [updateSql] = mockDb.query.mock.calls[1] as [string, unknown[]];
      expect(updateSql).toContain('UPDATE occasions');
      expect(updateSql).toContain('last_reminded_year');
    });

    it('sends occasion reminder with days_away from remind_days_before', async () => {
      mockDb.query
        .mockResolvedValueOnce([
          {
            id: 'occ-002',
            connection_id: CONN_ID,
            occasion_name: 'Anniversary',
            occasion_date: '2026-06-03',
            remind_days_before: 7,
            user_a_id: USER_A,
            user_b_id: USER_B,
            name_for_a: 'Priya',
            name_for_b: 'Aarav',
          },
        ])
        .mockResolvedValueOnce([]);

      await service.sendOccasionReminders();

      expect(mockNotificationsService.renderTemplate).toHaveBeenCalledWith(
        'occasion',
        expect.objectContaining({ days_away: '7', occasion_name: 'Anniversary' }),
      );
    });

    it('does not throw when DB query fails', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('DB error'));

      await expect(service.sendOccasionReminders()).resolves.not.toThrow();
    });
  });
});
