import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { MemoryTreeService, computeDiaryWeather, MonthData } from './memory-tree.service';

const CONN_ID = 'conn-uuid-001';

const CONN_ROW = {
  streak_count: 14,
  longest_streak: 30,
  diary_weather: 'partly_cloudy',
};

function makeAggRow(yearMonth: string, entryCount: number, voiceCount = entryCount, videoCount = 0) {
  return {
    year_month: yearMonth,
    entry_count: String(entryCount),
    voice_count: String(voiceCount),
    video_count: String(videoCount),
    mood_happy: '2',
    mood_calm: '1',
    mood_thoughtful: '0',
    mood_missing: '0',
    mood_excited: '0',
  };
}

describe('MemoryTreeService', () => {
  let service: MemoryTreeService;
  let mockDb: { query: jest.Mock };

  beforeEach(async () => {
    mockDb = { query: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryTreeService,
        { provide: getDataSourceToken(), useValue: mockDb },
      ],
    }).compile();

    service = module.get<MemoryTreeService>(MemoryTreeService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── getMemoryTree (cache path) ─────────────────────────────────────────────

  describe('getMemoryTree', () => {
    it('returns cached data without recomputing when cache is fresh', async () => {
      const cachedMonths: MonthData[] = [
        {
          year_month: '2026-04',
          entry_count: 8,
          voice_count: 6,
          video_count: 2,
          mood_distribution: { happy: 3, calm: 2, thoughtful: 1, missing: 1, excited: 1 },
          has_milestone: false,
          node_health: 0.8,
        },
      ];

      mockDb.query
        .mockResolvedValueOnce([{
          monthly_data: cachedMonths,
          total_entries: 8,
          active_months: 1,
          tree_health: 0.8,
          last_computed_at: new Date(),
        }])
        .mockResolvedValueOnce([CONN_ROW]); // fresh streak

      const result = await service.getMemoryTree('user-1', CONN_ID);

      expect(result.months).toHaveLength(1);
      expect(result.months[0].year_month).toBe('2026-04');
      expect(result.streak_count).toBe(14);
      expect(result.diary_weather).toBe('partly_cloudy');

      // Aggregation query must NOT have run (only 2 queries: cache check + conn row)
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });

    it('recomputes when cache is stale (no row returned)', async () => {
      mockDb.query
        .mockResolvedValueOnce([])                                        // cache miss
        .mockResolvedValueOnce([makeAggRow('2026-05', 5)])                // aggregation
        .mockResolvedValueOnce([])                                        // no milestones
        .mockResolvedValueOnce([CONN_ROW])                                // streak row
        .mockResolvedValueOnce([]);                                       // cache upsert

      const result = await service.getMemoryTree('user-1', CONN_ID);

      expect(result.months).toHaveLength(1);
      expect(result.months[0].year_month).toBe('2026-05');
      expect(mockDb.query).toHaveBeenCalledTimes(5);
    });
  });

  // ── computeMemoryTree ──────────────────────────────────────────────────────

  describe('computeMemoryTree', () => {
    it('computes node_health as min(1.0, entry_count / 10)', async () => {
      mockDb.query
        .mockResolvedValueOnce([
          makeAggRow('2026-05', 15),  // 15 entries → capped at 1.0
          makeAggRow('2026-04', 5),   // 5 entries → 0.5
        ])
        .mockResolvedValueOnce([])    // no milestones
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce([]);   // cache upsert

      const result = await service.computeMemoryTree(CONN_ID);

      const may = result.months.find((m) => m.year_month === '2026-05');
      const apr = result.months.find((m) => m.year_month === '2026-04');

      expect(may?.node_health).toBe(1.0);
      expect(apr?.node_health).toBe(0.5);
    });

    it('computes tree_health as recency-weighted average of last 3 months', async () => {
      // Months with health: 2026-03=0.2, 2026-04=0.5, 2026-05=1.0
      // Weighted: 0.2*0.2 + 0.5*0.3 + 1.0*0.5 = 0.04 + 0.15 + 0.5 = 0.69
      mockDb.query
        .mockResolvedValueOnce([
          makeAggRow('2026-03', 2),
          makeAggRow('2026-04', 5),
          makeAggRow('2026-05', 10),
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce([]);

      const result = await service.computeMemoryTree(CONN_ID);

      // tree_health = 0.69 (rounded to 2 decimal places)
      expect(result.tree_health).toBeCloseTo(0.69, 2);
    });

    it('marks has_milestone=true for months where a milestone was achieved', async () => {
      // Milestone achieved in 2026-05
      mockDb.query
        .mockResolvedValueOnce([
          makeAggRow('2026-04', 5),
          makeAggRow('2026-05', 8),
        ])
        .mockResolvedValueOnce([
          { milestone_days: 30, achieved_at: new Date('2026-05-15T10:00:00Z') },
        ])
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce([]);

      const result = await service.computeMemoryTree(CONN_ID);

      const may = result.months.find((m) => m.year_month === '2026-05');
      const apr = result.months.find((m) => m.year_month === '2026-04');

      expect(may?.has_milestone).toBe(true);
      expect(apr?.has_milestone).toBe(false);
    });

    it('correctly builds mood_distribution from COUNT FILTER rows', async () => {
      const row = {
        year_month: '2026-05',
        entry_count: '10',
        voice_count: '8',
        video_count: '2',
        mood_happy: '3',
        mood_calm: '2',
        mood_thoughtful: '1',
        mood_missing: '2',
        mood_excited: '2',
      };

      mockDb.query
        .mockResolvedValueOnce([row])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce([]);

      const result = await service.computeMemoryTree(CONN_ID);
      const dist = result.months[0].mood_distribution;

      expect(dist.happy).toBe(3);
      expect(dist.calm).toBe(2);
      expect(dist.missing).toBe(2);
    });

    it('upserts cache after computation', async () => {
      mockDb.query
        .mockResolvedValueOnce([makeAggRow('2026-05', 5)])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce([]); // cache upsert

      await service.computeMemoryTree(CONN_ID);

      const upsertCall = mockDb.query.mock.calls.find(([sql]: [string]) =>
        sql.includes('ON CONFLICT (connection_id)'),
      );
      expect(upsertCall).toBeDefined();
    });

    it('returns empty months and zero health for connections with no entries', async () => {
      mockDb.query
        .mockResolvedValueOnce([]) // no aggregation rows
        .mockResolvedValueOnce([]) // no milestones
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce([]); // cache upsert

      const result = await service.computeMemoryTree(CONN_ID);

      expect(result.months).toHaveLength(0);
      expect(result.tree_health).toBe(0);
      expect(result.total_entries).toBe(0);
      expect(result.active_months).toBe(0);
    });

    it('handles cache upsert failure gracefully (returns data anyway)', async () => {
      mockDb.query
        .mockResolvedValueOnce([makeAggRow('2026-05', 5)])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([CONN_ROW])
        .mockRejectedValueOnce(new Error('DB upsert failed')); // cache fails

      // Should NOT throw
      const result = await service.computeMemoryTree(CONN_ID);
      expect(result.months).toHaveLength(1);
    });
  });

  // ── getMonthDetail ─────────────────────────────────────────────────────────

  describe('getMonthDetail', () => {
    const ENTRIES_ROW = {
      id: 'e1', connection_id: CONN_ID, author_id: 'u1',
      entry_type: 'voice', duration_seconds: 15,
      transcription: 'hello', transcription_status: 'done',
      mood: 'happy', is_starred: false, starred_at: null,
      play_count: 1, recorded_at: new Date('2026-05-10T10:00:00Z'),
      created_at: new Date('2026-05-10T10:00:00Z'),
    };

    it('returns entries and month_stats for a valid year_month', async () => {
      mockDb.query
        .mockResolvedValueOnce([ENTRIES_ROW])         // entries
        .mockResolvedValueOnce([makeAggRow('', 1)])   // stats
        .mockResolvedValueOnce([{ count: '0' }]);     // milestone check

      const result = await service.getMonthDetail('user-1', CONN_ID, '2026-05');

      expect(result.entries).toHaveLength(1);
      expect(result.month_stats.year_month).toBe('2026-05');
      expect(result.month_stats.entry_count).toBe(1);
      expect(result.month_stats.node_health).toBeCloseTo(0.1, 2);
    });

    it('throws INVALID_YEAR_MONTH for malformed format', async () => {
      await expect(
        service.getMonthDetail('user-1', CONN_ID, 'May 2026'),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.getMonthDetail('user-1', CONN_ID, '2026-5'),
      ).rejects.toThrow(BadRequestException);
    });

    it('handles December correctly (next month wraps to January)', async () => {
      mockDb.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeAggRow('', 0)])
        .mockResolvedValueOnce([{ count: '0' }]);

      await service.getMonthDetail('user-1', CONN_ID, '2026-12');

      // Verify the date range passed to the query includes Jan 2027
      // query is called as (sql, [connId, startDate, nextMonth])
      const [, params] = mockDb.query.mock.calls[0] as [string, [string, string, string]];
      expect(params[1]).toBe('2026-12-01');
      expect(params[2]).toBe('2027-01-01');
    });

    it('marks has_milestone=true when milestone achieved that month', async () => {
      mockDb.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeAggRow('', 5)])
        .mockResolvedValueOnce([{ count: '1' }]); // one milestone this month

      const result = await service.getMonthDetail('user-1', CONN_ID, '2026-05');

      expect(result.month_stats.has_milestone).toBe(true);
    });
  });

  // ── invalidateCache ────────────────────────────────────────────────────────

  describe('invalidateCache', () => {
    it('deletes the cache row for the connection', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await service.invalidateCache(CONN_ID);

      const [sql, params] = mockDb.query.mock.calls[0] as [string, string[]];
      expect(sql).toContain('DELETE FROM memory_tree_cache');
      expect(params).toContain(CONN_ID);
    });

    it('does not throw if cache delete fails', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('DB error'));

      await expect(service.invalidateCache(CONN_ID)).resolves.not.toThrow();
    });
  });

  // ── computeDiaryWeather ────────────────────────────────────────────────────

  describe('computeDiaryWeather', () => {
    it.each([
      [30, 0,  'sunny'],
      [30, 2,  'sunny'],
      [30, 3,  'partly_cloudy'],  // over the sunny threshold
      [15, 1,  'partly_cloudy'],
      [5,  2,  'cloudy'],
      [3,  5,  'cloudy'],
      [3,  6,  'dormant'],
      [2,  1,  'dormant'],        // streak too low
      [30, 31, 'dormant'],        // no entry in 31 days
    ])(
      'streak=%i, daysSince=%i → %s',
      (streak, days, expected) => {
        expect(computeDiaryWeather(streak, days)).toBe(expected);
      },
    );
  });
});
