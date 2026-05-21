import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { TooManyRequestsException } from '../shared/exceptions/too-many-requests.exception';
import { OccasionsService } from './occasions.service';

const USER_A = 'user-a-uuid';
const USER_B = 'user-b-uuid';
const CONN_ID = 'conn-uuid-001';
const OCC_ID  = 'occ-uuid-001';

const BASE_CONN = {
  relationship_type: 'parent_child',
  name_for_a: 'Priya',
  name_for_b: 'Aarav',
  user_a_id: USER_A,
  user_b_id: USER_B,
};

const BASE_OCCASION = {
  id: OCC_ID,
  connection_id: CONN_ID,
  created_by: USER_A,
  occasion_type: 'birthday',
  occasion_name: "Aarav's Birthday",
  occasion_date: '2026-07-15',
  is_recurring: true,
  remind_days_before: 5,
  last_reminded_year: null,
  created_at: new Date('2026-05-01T00:00:00Z'),
};

describe('OccasionsService', () => {
  let service: OccasionsService;
  let mockDb: { query: jest.Mock };
  let mockConfig: { get: jest.Mock };

  beforeEach(async () => {
    mockDb    = { query: jest.fn() };
    mockConfig = { get: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OccasionsService,
        { provide: getDataSourceToken(), useValue: mockDb },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<OccasionsService>(OccasionsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── createOccasion ─────────────────────────────────────────────────────────

  describe('createOccasion', () => {
    it('inserts occasion and returns the created row', async () => {
      mockDb.query.mockResolvedValueOnce([BASE_OCCASION]);

      const result = await service.createOccasion(USER_A, CONN_ID, {
        occasion_type: 'birthday',
        occasion_name: "Aarav's Birthday",
        occasion_date: '2026-07-15',
        is_recurring: true,
        remind_days_before: 5,
      });

      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO occasions');
      expect(params[0]).toBe(CONN_ID);
      expect(params[1]).toBe(USER_A);
      expect(params[3]).toBe("Aarav's Birthday");
      expect(result.id).toBe(OCC_ID);
    });

    it('uses occasion_type as name when occasion_name is not provided', async () => {
      mockDb.query.mockResolvedValueOnce([{ ...BASE_OCCASION, occasion_name: 'birthday' }]);

      await service.createOccasion(USER_A, CONN_ID, {
        occasion_type: 'birthday',
        occasion_date: '2026-07-15',
        is_recurring: true,
        remind_days_before: 5,
      });

      const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      // params[3] is occasion_name — should fall back to occasion_type
      expect(params[3]).toBe('birthday');
    });
  });

  // ── getOccasions ───────────────────────────────────────────────────────────

  describe('getOccasions', () => {
    it('returns occasions ordered by occasion_date', async () => {
      const occasions = [BASE_OCCASION, { ...BASE_OCCASION, id: 'occ-002', occasion_date: '2026-12-25' }];
      mockDb.query.mockResolvedValueOnce(occasions);

      const result = await service.getOccasions(USER_A, CONN_ID);

      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('ORDER BY occasion_date ASC');
      expect(params[0]).toBe(CONN_ID);
      expect(result).toHaveLength(2);
    });
  });

  // ── deleteOccasion ─────────────────────────────────────────────────────────

  describe('deleteOccasion', () => {
    it('deletes occasion when user is creator', async () => {
      mockDb.query.mockResolvedValueOnce([{ id: OCC_ID }]);

      await expect(
        service.deleteOccasion(USER_A, CONN_ID, OCC_ID),
      ).resolves.not.toThrow();

      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('DELETE FROM occasions');
      expect(params[0]).toBe(OCC_ID);
      expect(params[1]).toBe(CONN_ID);
      expect(params[2]).toBe(USER_A);
    });

    it('throws NotFoundException when occasion not found or user is not creator', async () => {
      mockDb.query.mockResolvedValueOnce([]); // no rows deleted

      await expect(
        service.deleteOccasion(USER_B, CONN_ID, OCC_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── generateAiMessage ──────────────────────────────────────────────────────

  describe('generateAiMessage', () => {
    it('throws NotFoundException when occasion not found', async () => {
      mockDb.query.mockResolvedValueOnce([]); // occasion not found

      await expect(
        service.generateAiMessage(USER_A, CONN_ID, OCC_ID, { language: 'en' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws TooManyRequestsException when rate limit exceeded', async () => {
      mockDb.query
        .mockResolvedValueOnce([BASE_OCCASION])  // occasion found
        .mockResolvedValueOnce([{ count: '5' }]); // 5 generations today

      await expect(
        service.generateAiMessage(USER_A, CONN_ID, OCC_ID, { language: 'en' }),
      ).rejects.toThrow(TooManyRequestsException);
    });

    it('returns placeholder when ANTHROPIC_API_KEY is not set', async () => {
      mockDb.query
        .mockResolvedValueOnce([BASE_OCCASION])           // occasion found
        .mockResolvedValueOnce([{ count: '0' }])           // rate limit ok
        .mockResolvedValueOnce([BASE_CONN])                // connection context
        .mockResolvedValueOnce([{ id: USER_A, name: 'Priya' }]) // user name
        .mockResolvedValueOnce([]);                        // INSERT ai message

      mockConfig.get.mockReturnValue(undefined); // no API key

      const result = await service.generateAiMessage(USER_A, CONN_ID, OCC_ID, { language: 'en' });

      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('stores result in occasion_ai_messages with correct columns', async () => {
      mockDb.query
        .mockResolvedValueOnce([BASE_OCCASION])
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([BASE_CONN])
        .mockResolvedValueOnce([{ id: USER_A, name: 'Priya' }])
        .mockResolvedValueOnce([]); // INSERT ai message

      mockConfig.get.mockReturnValue(undefined); // no key → placeholder

      await service.generateAiMessage(USER_A, CONN_ID, OCC_ID, { language: 'hi', tone: 'warm' });

      const insertCall = mockDb.query.mock.calls[4] as [string, unknown[]];
      expect(insertCall[0]).toContain('INSERT INTO occasion_ai_messages');
      expect(insertCall[0]).toContain('occasion_id');
      expect(insertCall[0]).toContain('generated_text');
      expect(insertCall[1][3]).toBe('hi'); // language param
    });

    it('uses partner name from name_for_b when requester is user_a', async () => {
      mockDb.query
        .mockResolvedValueOnce([BASE_OCCASION])
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([BASE_CONN])
        .mockResolvedValueOnce([{ id: USER_A, name: 'Priya' }])
        .mockResolvedValueOnce([]);

      mockConfig.get.mockReturnValue(undefined);

      // Should not throw — just verifying it runs without error
      await expect(
        service.generateAiMessage(USER_A, CONN_ID, OCC_ID, { language: 'en' }),
      ).resolves.toBeTruthy();
    });

    it('throws NotFoundException when connection not found', async () => {
      mockDb.query
        .mockResolvedValueOnce([BASE_OCCASION])
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]); // connection not found

      await expect(
        service.generateAiMessage(USER_A, CONN_ID, OCC_ID, { language: 'en' }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
