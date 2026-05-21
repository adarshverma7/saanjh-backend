import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { OnThisDayService } from './on-this-day.service';

const CONN_ID = 'conn-uuid-001';
const USER_ID = 'user-uuid-001';

function makeEntry(recordedAt: Date, id = 'entry-001') {
  return {
    id,
    connection_id: CONN_ID,
    author_id: USER_ID,
    entry_type: 'voice',
    duration_seconds: 12,
    transcription: 'Yaad hai na?',
    transcription_status: 'done',
    mood: 'calm',
    is_starred: false,
    starred_at: null,
    play_count: 1,
    recorded_at: recordedAt,
    created_at: recordedAt,
  };
}

describe('OnThisDayService', () => {
  let service: OnThisDayService;
  let mockDb: { query: jest.Mock };

  beforeEach(async () => {
    mockDb = { query: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnThisDayService,
        { provide: getDataSourceToken(), useValue: mockDb },
      ],
    }).compile();

    service = module.get<OnThisDayService>(OnThisDayService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Query construction ─────────────────────────────────────────────────────

  describe('query construction', () => {
    it('passes correct month and day params to the SQL query', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await service.getOnThisDay(USER_ID, CONN_ID, '2024-05-20');

      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('AT TIME ZONE');
      expect(sql).toContain("'Asia/Kolkata'");
      expect(params[0]).toBe(CONN_ID);
      expect(params[1]).toBe(5);   // month = May
      expect(params[2]).toBe(20);  // day = 20
    });

    it('excludes current-year entries via EXTRACT(YEAR) comparison', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await service.getOnThisDay(USER_ID, CONN_ID, '2024-05-20');

      const [sql] = mockDb.query.mock.calls[0] as [string];
      // Must filter out current year
      expect(sql).toContain('EXTRACT(YEAR');
      expect(sql).toContain('< EXTRACT(YEAR FROM NOW()');
    });

    it('uses IST (Asia/Kolkata) for all EXTRACT calls', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await service.getOnThisDay(USER_ID, CONN_ID, '2024-05-20');

      const [sql] = mockDb.query.mock.calls[0] as [string];
      // All three EXTRACT calls must include the timezone
      const timezoneMatches = (sql.match(/AT TIME ZONE 'Asia\/Kolkata'/g) ?? []).length;
      expect(timezoneMatches).toBeGreaterThanOrEqual(3); // MONTH, DAY, YEAR extracts
    });
  });

  // ── Result shape ───────────────────────────────────────────────────────────

  describe('result shape', () => {
    it('returns entries, years (sorted desc), has_entries=true', async () => {
      const e2024 = makeEntry(new Date('2024-05-20T10:00:00Z'), 'e-2024');
      const e2023 = makeEntry(new Date('2023-05-20T10:00:00Z'), 'e-2023');
      mockDb.query.mockResolvedValueOnce([e2024, e2023]);

      const result = await service.getOnThisDay(USER_ID, CONN_ID, '2026-05-20');

      expect(result.has_entries).toBe(true);
      expect(result.entries).toHaveLength(2);
      expect(result.years).toContain(2024);
      expect(result.years).toContain(2023);
      // Most recent year first
      expect(result.years[0]).toBeGreaterThan(result.years[1]);
    });

    it('returns has_entries=false and empty years when no matching entries', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      const result = await service.getOnThisDay(USER_ID, CONN_ID, '2026-05-20');

      expect(result.has_entries).toBe(false);
      expect(result.entries).toHaveLength(0);
      expect(result.years).toHaveLength(0);
    });

    it('deduplicates years when multiple entries exist in the same year', async () => {
      // Two entries from May 20, 2024
      const e1 = makeEntry(new Date('2024-05-20T09:00:00Z'), 'e-2024-a');
      const e2 = makeEntry(new Date('2024-05-20T14:00:00Z'), 'e-2024-b');
      mockDb.query.mockResolvedValueOnce([e1, e2]);

      const result = await service.getOnThisDay(USER_ID, CONN_ID, '2026-05-20');

      // Year 2024 should appear only once
      expect(result.years.filter((y) => y === 2024)).toHaveLength(1);
    });

    it('returns month and day in the result for Flutter to display', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      const result = await service.getOnThisDay(USER_ID, CONN_ID, '2026-03-15');

      expect(result.month).toBe(3);
      expect(result.day).toBe(15);
    });
  });

  // ── Date parsing ───────────────────────────────────────────────────────────

  describe('date parsing', () => {
    it('uses IST today when no date is provided', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await service.getOnThisDay(USER_ID, CONN_ID);

      const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      const month = params[1] as number;
      const day = params[2] as number;

      // Month and day must be valid calendar values
      expect(month).toBeGreaterThanOrEqual(1);
      expect(month).toBeLessThanOrEqual(12);
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(31);
    });

    it('throws INVALID_DATE_FORMAT for wrong date format', async () => {
      await expect(
        service.getOnThisDay(USER_ID, CONN_ID, '20-05-2026'),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.getOnThisDay(USER_ID, CONN_ID, 'not-a-date'),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.getOnThisDay(USER_ID, CONN_ID, '2026/05/20'),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts valid YYYY-MM-DD format', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await expect(
        service.getOnThisDay(USER_ID, CONN_ID, '2026-01-01'),
      ).resolves.not.toThrow();
    });
  });

  // ── IST timezone correctness ───────────────────────────────────────────────

  describe('IST timezone edge case', () => {
    it('IST year is derived from UTC timestamp with +5:30 offset', async () => {
      // A recording at 2024-05-20T20:00:00Z = 2024-05-21T01:30:00 IST
      // The IST year is still 2024, so this should appear in year 2024
      const e = makeEntry(new Date('2024-05-20T20:00:00Z'));
      mockDb.query.mockResolvedValueOnce([e]);

      const result = await service.getOnThisDay(USER_ID, CONN_ID, '2026-05-21');

      expect(result.years).toContain(2024);
    });
  });
});
