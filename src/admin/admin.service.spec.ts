import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';

const USER_ID = 'user-uuid-001';

const RAW_USER = {
  id: USER_ID,
  phone: '+919876543210',
  name: 'Priya Sharma',
  is_onboarded: true,
  is_active: true,
  is_verified: true,
  last_active_at: new Date('2026-05-20T10:00:00Z'),
  created_at: new Date('2026-01-01T00:00:00Z'),
};

describe('AdminService', () => {
  let service: AdminService;
  let mockDb: { query: jest.Mock };

  beforeEach(async () => {
    mockDb = { query: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: getDataSourceToken(), useValue: mockDb },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── getUserList ─────────────────────────────────────────────────────────────

  describe('getUserList', () => {
    it('returns paginated users with masked phone numbers', async () => {
      mockDb.query
        .mockResolvedValueOnce([RAW_USER])       // users
        .mockResolvedValueOnce([{ count: '1' }]); // total count

      const result = await service.getUserList(1, 20);

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      // Phone must be masked — never return raw phone
      expect(result.items[0].phone_masked).not.toBe(RAW_USER.phone);
      expect(result.items[0].phone_masked).toContain('X');
    });

    it('applies search filter with ILIKE when search is provided', async () => {
      mockDb.query
        .mockResolvedValueOnce([RAW_USER])
        .mockResolvedValueOnce([{ count: '1' }]);

      await service.getUserList(1, 20, 'Priya');

      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('ILIKE');
      expect(params).toContain('%Priya%');
    });

    it('uses correct OFFSET for pagination', async () => {
      mockDb.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: '0' }]);

      await service.getUserList(3, 10); // page 3 → offset 20

      const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(params[1]).toBe(20); // offset
    });
  });

  // ── getUserDetail ───────────────────────────────────────────────────────────

  describe('getUserDetail', () => {
    it('returns user detail with connection/entry counts and masked phone', async () => {
      mockDb.query
        .mockResolvedValueOnce([RAW_USER])           // user
        .mockResolvedValueOnce([{ count: '3' }])      // connections
        .mockResolvedValueOnce([{ count: '47' }])     // entries
        .mockResolvedValueOnce([])                    // device sessions
        .mockResolvedValueOnce([]);                   // audit logs

      const result = await service.getUserDetail(USER_ID);

      expect(result.id).toBe(USER_ID);
      expect(result.connection_count).toBe(3);
      expect(result.entry_count).toBe(47);
      expect(result.phone_masked).toContain('X');
    });

    it('throws NotFoundException when user not found', async () => {
      // Promise.all — mock all 5 parallel queries
      mockDb.query
        .mockResolvedValueOnce([])  // user not found
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await expect(service.getUserDetail('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ── suspendUser ─────────────────────────────────────────────────────────────

  describe('suspendUser', () => {
    it('updates user, deactivates sessions, and inserts audit log', async () => {
      mockDb.query
        .mockResolvedValueOnce([])  // UPDATE users
        .mockResolvedValueOnce([])  // UPDATE device_sessions
        .mockResolvedValueOnce([]); // INSERT audit_log

      await service.suspendUser('admin', USER_ID, 'Spam');

      expect(mockDb.query).toHaveBeenCalledTimes(3);

      const [userSql] = mockDb.query.mock.calls[0] as [string];
      expect(userSql).toContain('is_active = false');

      const [sessionSql] = mockDb.query.mock.calls[1] as [string];
      expect(sessionSql).toContain('device_sessions');

      const [auditSql, auditParams] = mockDb.query.mock.calls[2] as [string, unknown[]];
      expect(auditSql).toContain('audit_logs');
      expect(auditSql).toContain('admin.user_suspended');
      expect(auditParams[0]).toBe(USER_ID);
    });

    it('includes reason in audit log metadata', async () => {
      mockDb.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.suspendUser('admin', USER_ID, 'Abusive content');

      const [, params] = mockDb.query.mock.calls[2] as [string, unknown[]];
      const metadata = JSON.parse(params[1] as string);
      expect(metadata.reason).toBe('Abusive content');
    });
  });

  // ── getAnalyticsOverview ────────────────────────────────────────────────────

  describe('getAnalyticsOverview', () => {
    it('runs all 6 count queries in parallel and returns parsed numbers', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ count: '150' }])   // DAU
        .mockResolvedValueOnce([{ count: '800' }])   // WAU
        .mockResolvedValueOnce([{ count: '2500' }])  // MAU
        .mockResolvedValueOnce([{ count: '12' }])    // new signups
        .mockResolvedValueOnce([{ count: '340' }])   // active connections
        .mockResolvedValueOnce([{ count: '85' }]);   // entries today

      const result = await service.getAnalyticsOverview();

      expect(result.dau).toBe(150);
      expect(result.wau).toBe(800);
      expect(result.mau).toBe(2500);
      expect(result.new_signups_today).toBe(12);
      expect(result.active_connections).toBe(340);
      expect(result.entries_today).toBe(85);
    });
  });

  // ── getFeatureFlags ─────────────────────────────────────────────────────────

  describe('getFeatureFlags', () => {
    it('returns flags ordered by key', async () => {
      const flags = [
        { key: 'memory_book', is_enabled: true, rollout_percentage: 100, description: null, updated_at: new Date() },
        { key: 'video_entry', is_enabled: false, rollout_percentage: 0, description: null, updated_at: new Date() },
      ];
      mockDb.query.mockResolvedValueOnce(flags);

      const result = await service.getFeatureFlags();
      expect(result).toHaveLength(2);

      const [sql] = mockDb.query.mock.calls[0] as [string];
      expect(sql).toContain('ORDER BY key');
    });
  });

  // ── updateFeatureFlag ───────────────────────────────────────────────────────

  describe('updateFeatureFlag', () => {
    it('updates flag and returns updated row', async () => {
      const updated = { key: 'memory_book', is_enabled: true, rollout_percentage: 50, description: null, updated_at: new Date() };
      mockDb.query.mockResolvedValueOnce([updated]);

      const result = await service.updateFeatureFlag('memory_book', true, 50);
      expect(result.rollout_percentage).toBe(50);
    });

    it('throws NotFoundException when flag key does not exist', async () => {
      mockDb.query.mockResolvedValueOnce([]); // no rows returned

      await expect(service.updateFeatureFlag('nonexistent_flag', true, 100))
        .rejects.toThrow(NotFoundException);
    });
  });

  // ── getOrders ───────────────────────────────────────────────────────────────

  describe('getOrders', () => {
    it('returns paginated orders', async () => {
      const order = { id: 'order-001', payment_status: 'paid', print_status: 'not_started', ordered_by_name: 'Priya' };
      mockDb.query
        .mockResolvedValueOnce([order])
        .mockResolvedValueOnce([{ count: '1' }]);

      const result = await service.getOrders(1, 20);
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('filters by status when provided', async () => {
      mockDb.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: '0' }]);

      await service.getOrders(1, 20, 'paid');

      const [sql] = mockDb.query.mock.calls[0] as [string];
      expect(sql).toContain('payment_status');
    });
  });

  // ── updateOrderStatus ───────────────────────────────────────────────────────

  describe('updateOrderStatus', () => {
    it('updates print_status and tracking_number', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await service.updateOrderStatus('order-001', 'shipped', 'TRK123456');

      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('print_status');
      expect(params[0]).toBe('shipped');
      expect(params[1]).toBe('TRK123456');
    });

    it('preserves existing tracking_number when not provided', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await service.updateOrderStatus('order-001', 'printing');

      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('COALESCE');
      expect(params[1]).toBeNull();
    });
  });
});
