import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SearchService } from './search.service';

const USER_A  = 'user-a-uuid';
const USER_B  = 'user-b-uuid';
const CONN_ID = 'conn-uuid-001';

const BASE_CONN = { user_a_id: USER_A, user_b_id: USER_B };

const SAMPLE_RESULT = {
  id: 'entry-001',
  connection_id: CONN_ID,
  author_id: USER_A,
  entry_type: 'voice',
  duration_seconds: 45,
  mood: 'happy',
  is_starred: false,
  recorded_at: new Date('2026-05-10T10:00:00Z'),
  snippet: 'We talked about <<birthdays>> and family',
};

describe('SearchService', () => {
  let service: SearchService;
  let mockDb: { query: jest.Mock };

  beforeEach(async () => {
    mockDb = { query: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: getDataSourceToken(), useValue: mockDb },
      ],
    }).compile();

    service = module.get<SearchService>(SearchService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Validation ──────────────────────────────────────────────────────────────

  describe('query validation', () => {
    it('throws BadRequestException for query shorter than 3 chars', async () => {
      await expect(service.searchEntries(USER_A, 'ab')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for empty query', async () => {
      await expect(service.searchEntries(USER_A, '')).rejects.toThrow(BadRequestException);
    });

    it('accepts query of exactly 3 characters', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ id: CONN_ID }])  // connections for user
        .mockResolvedValueOnce([SAMPLE_RESULT]);    // search results

      await expect(service.searchEntries(USER_A, 'mum')).resolves.not.toThrow();
    });
  });

  // ── Security — connectionId provided ────────────────────────────────────────

  describe('with connectionId filter', () => {
    it('returns results when user is connection member (user_a)', async () => {
      mockDb.query
        .mockResolvedValueOnce([BASE_CONN])      // member check
        .mockResolvedValueOnce([SAMPLE_RESULT]); // search

      const result = await service.searchEntries(USER_A, 'birthday', CONN_ID);

      expect(result).toHaveLength(1);
      expect(result[0].snippet).toContain('<<birthdays>>');
    });

    it('returns results when user is connection member (user_b)', async () => {
      mockDb.query
        .mockResolvedValueOnce([BASE_CONN])
        .mockResolvedValueOnce([SAMPLE_RESULT]);

      const result = await service.searchEntries(USER_B, 'birthday', CONN_ID);
      expect(result).toHaveLength(1);
    });

    it('throws ForbiddenException when user is not a member of specified connection', async () => {
      mockDb.query.mockResolvedValueOnce([BASE_CONN]); // conn exists but user-c not in it

      await expect(
        service.searchEntries('user-c-uuid', 'birthday', CONN_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException when connection does not exist', async () => {
      mockDb.query.mockResolvedValueOnce([]); // no connection

      await expect(
        service.searchEntries(USER_A, 'birthday', 'nonexistent-conn'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Security — no connectionId (search all user connections) ────────────────

  describe('without connectionId', () => {
    it('searches all active connections for the user', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ id: CONN_ID }, { id: 'conn-uuid-002' }]) // user's connections
        .mockResolvedValueOnce([SAMPLE_RESULT]);                            // search

      const result = await service.searchEntries(USER_A, 'birthday');

      expect(result).toHaveLength(1);

      // Verify both connection IDs were passed to the search query
      const [, params] = mockDb.query.mock.calls[1] as [string, unknown[]];
      expect(params[0]).toContain(CONN_ID);
      expect(params[0]).toContain('conn-uuid-002');
    });

    it('returns empty array when user has no connections', async () => {
      mockDb.query.mockResolvedValueOnce([]); // no connections

      const result = await service.searchEntries(USER_A, 'birthday');
      expect(result).toEqual([]);
      expect(mockDb.query).toHaveBeenCalledTimes(1); // only the connections query
    });
  });

  // ── Query construction ──────────────────────────────────────────────────────

  describe('SQL query', () => {
    it('uses ts_headline with correct markers', async () => {
      mockDb.query
        .mockResolvedValueOnce([BASE_CONN])
        .mockResolvedValueOnce([]);

      await service.searchEntries(USER_A, 'memory', CONN_ID);

      const [sql] = mockDb.query.mock.calls[1] as [string];
      expect(sql).toContain('ts_headline');
      expect(sql).toContain('StartSel=<<');
      expect(sql).toContain('StopSel=>>');
    });

    it('uses plainto_tsquery and ts_rank for ordered results', async () => {
      mockDb.query
        .mockResolvedValueOnce([BASE_CONN])
        .mockResolvedValueOnce([]);

      await service.searchEntries(USER_A, 'voice notes', CONN_ID);

      const [sql] = mockDb.query.mock.calls[1] as [string];
      expect(sql).toContain('plainto_tsquery');
      expect(sql).toContain('ts_rank');
      expect(sql).toContain("transcription_status = 'done'");
    });

    it('clamps limit to maximum 50', async () => {
      mockDb.query
        .mockResolvedValueOnce([BASE_CONN])
        .mockResolvedValueOnce([]);

      await service.searchEntries(USER_A, 'memory', CONN_ID, 999);

      const [, params] = mockDb.query.mock.calls[1] as [string, unknown[]];
      expect(params[2]).toBe(50); // clamped from 999
    });

    it('trims whitespace from query before passing to PostgreSQL', async () => {
      mockDb.query
        .mockResolvedValueOnce([BASE_CONN])
        .mockResolvedValueOnce([]);

      await service.searchEntries(USER_A, '  hello world  ', CONN_ID);

      const [, params] = mockDb.query.mock.calls[1] as [string, unknown[]];
      expect(params[1]).toBe('hello world');
    });
  });
});
