import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  StreaksService,
  toISTDate,
  diffInCalendarDays,
  computeWeather,
} from './streaks.service';

const CONN_ID = 'conn-uuid-001';
const USER_A  = 'user-a-uuid';
const USER_B  = 'user-b-uuid';

const BASE_CONN = {
  user_a_id: USER_A,
  user_b_id: USER_B,
  streak_count: 0,
  longest_streak: 0,
  streak_last_date: null,
  streak_started_at: null,
};

describe('StreaksService', () => {
  let service: StreaksService;
  let mockDb: { query: jest.Mock };
  let mockEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    mockDb    = { query: jest.fn() };
    mockEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StreaksService,
        { provide: getDataSourceToken(), useValue: mockDb },
        { provide: EventEmitter2, useValue: mockEmitter },
      ],
    }).compile();

    service = module.get<StreaksService>(StreaksService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── onNewEntry ─────────────────────────────────────────────────────────────

  describe('onNewEntry', () => {
    it('sets streak=1 and weather=cloudy on first entry ever', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ ...BASE_CONN, streak_last_date: null }])
        .mockResolvedValueOnce([]);

      await service.onNewEntry(CONN_ID, new Date('2026-05-20T14:30:00Z'));

      const [sql, params] = mockDb.query.mock.calls[1] as [string, unknown[]];
      expect(sql).toContain('streak_count     = 1');
      expect(sql).toContain("diary_weather     = 'cloudy'");
      expect(params[0]).toBe('2026-05-20'); // IST date
    });

    it('does nothing when entry is recorded on the same IST day', async () => {
      mockDb.query.mockResolvedValueOnce([
        { ...BASE_CONN, streak_count: 5, streak_last_date: '2026-05-20' },
      ]);

      await service.onNewEntry(CONN_ID, new Date('2026-05-20T14:30:00Z'));

      // Only 1 query (FOR UPDATE select) — no UPDATE issued
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it('extends streak by 1 on a consecutive IST day', async () => {
      mockDb.query
        .mockResolvedValueOnce([
          { ...BASE_CONN, streak_count: 5, longest_streak: 5, streak_last_date: '2026-05-19' },
        ])
        .mockResolvedValueOnce([]) // UPDATE streak
        .mockResolvedValueOnce([]); // milestone check (6 not a milestone)

      await service.onNewEntry(CONN_ID, new Date('2026-05-20T14:30:00Z'));

      const [sql, params] = mockDb.query.mock.calls[1] as [string, unknown[]];
      expect(sql).toContain('streak_count    = $1');
      expect(params[0]).toBe(6);
      expect(params[1]).toBe('2026-05-20');
      expect(params[2]).toBe(6); // longest_streak also updated
    });

    it('updates longest_streak when new streak exceeds previous best', async () => {
      mockDb.query
        .mockResolvedValueOnce([
          { ...BASE_CONN, streak_count: 29, longest_streak: 30, streak_last_date: '2026-05-19' },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.onNewEntry(CONN_ID, new Date('2026-05-20T14:30:00Z'));

      const params = mockDb.query.mock.calls[1][1] as number[];
      // New streak = 30, previous longest = 30, new longest = max(30, 30) = 30
      expect(params[2]).toBe(30);
    });

    it('resets streak to 1 when IST gap > 1 day', async () => {
      mockDb.query
        .mockResolvedValueOnce([
          { ...BASE_CONN, streak_count: 14, longest_streak: 14, streak_last_date: '2026-05-16' },
        ])
        .mockResolvedValueOnce([]); // reset UPDATE

      await service.onNewEntry(CONN_ID, new Date('2026-05-20T14:30:00Z'));

      const [sql, params] = mockDb.query.mock.calls[1] as [string, unknown[]];
      expect(sql).toContain('streak_count     = 1');
      expect(sql).toContain("diary_weather     = 'partly_cloudy'");
      expect(params[0]).toBe('2026-05-20');
    });

    it('returns early when connection not found', async () => {
      mockDb.query.mockResolvedValueOnce([]); // no connection row

      await expect(
        service.onNewEntry(CONN_ID, new Date()),
      ).resolves.not.toThrow();

      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });
  });

  // ── checkMilestones ────────────────────────────────────────────────────────

  describe('checkMilestones', () => {
    it('inserts milestone and emits event when streak hits a milestone day', async () => {
      mockDb.query.mockResolvedValueOnce([{ id: 'ms-uuid' }]); // new insert

      await service.checkMilestones(CONN_ID, 7);

      expect(mockEmitter.emit).toHaveBeenCalledWith(
        'streak.milestone',
        { connectionId: CONN_ID, milestoneDay: 7 },
      );
    });

    it('does not emit when milestone was already achieved (ON CONFLICT DO NOTHING)', async () => {
      mockDb.query.mockResolvedValueOnce([]); // RETURNING id → empty (conflict, no insert)

      await service.checkMilestones(CONN_ID, 30);

      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });

    it('skips non-milestone streak values silently', async () => {
      await service.checkMilestones(CONN_ID, 6); // 6 is not in MILESTONE_DAYS

      expect(mockDb.query).not.toHaveBeenCalled();
      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });

    it.each([7, 30, 60, 100, 200, 365])(
      'recognises %i days as a milestone',
      async (days) => {
        mockDb.query.mockResolvedValueOnce([{ id: 'ms-uuid' }]);
        await service.checkMilestones(CONN_ID, days);
        expect(mockEmitter.emit).toHaveBeenCalledWith('streak.milestone', expect.any(Object));
        jest.clearAllMocks();
      },
    );
  });

  // ── getStreakData ──────────────────────────────────────────────────────────

  describe('getStreakData', () => {
    it('returns correct streak data with milestones seen_by_me for user_a', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ // conn row
          user_a_id: USER_A, user_b_id: USER_B,
          streak_count: 14, longest_streak: 30,
          streak_last_date: '2026-05-20',
          streak_started_at: '2026-05-07',
        }])
        .mockResolvedValueOnce([{ total_days: '20' }]) // distinct days
        .mockResolvedValueOnce([{                      // milestones
          milestone_days: 7, achieved_at: new Date('2026-05-13'),
          seen_by_a: true, seen_by_b: false,
        }]);

      const result = await service.getStreakData(USER_A, CONN_ID);

      expect(result.current_streak).toBe(14);
      expect(result.longest_streak).toBe(30);
      expect(result.streak_started_at).toBe('2026-05-07');
      expect(result.total_entry_days).toBe(20);
      expect(result.milestones).toHaveLength(1);
      // user_a looking — seen_by_a = true
      expect(result.milestones[0].seen_by_me).toBe(true);
    });

    it('marks seen_by_me=false for user_b when seen_by_b=false', async () => {
      mockDb.query
        .mockResolvedValueOnce([{
          user_a_id: USER_A, user_b_id: USER_B,
          streak_count: 7, longest_streak: 7,
          streak_last_date: '2026-05-20', streak_started_at: '2026-05-14',
        }])
        .mockResolvedValueOnce([{ total_days: '7' }])
        .mockResolvedValueOnce([{
          milestone_days: 7, achieved_at: new Date(),
          seen_by_a: true, seen_by_b: false, // user_b hasn't seen it
        }]);

      const result = await service.getStreakData(USER_B, CONN_ID);

      expect(result.milestones[0].seen_by_me).toBe(false);
    });

    it('sets at_risk=true when streak > 0 and no entry today', async () => {
      // streak_last_date is yesterday → at_risk
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const yesterdayIST = toISTDate(yesterday);

      mockDb.query
        .mockResolvedValueOnce([{
          user_a_id: USER_A, user_b_id: USER_B,
          streak_count: 5, longest_streak: 5,
          streak_last_date: yesterdayIST, streak_started_at: yesterdayIST,
        }])
        .mockResolvedValueOnce([{ total_days: '5' }])
        .mockResolvedValueOnce([]);

      const result = await service.getStreakData(USER_A, CONN_ID);

      expect(result.at_risk).toBe(true);
    });

    it('sets at_risk=false when streak_count=0', async () => {
      mockDb.query
        .mockResolvedValueOnce([{
          user_a_id: USER_A, user_b_id: USER_B,
          streak_count: 0, longest_streak: 0,
          streak_last_date: null, streak_started_at: null,
        }])
        .mockResolvedValueOnce([{ total_days: '0' }])
        .mockResolvedValueOnce([]);

      const result = await service.getStreakData(USER_A, CONN_ID);

      expect(result.at_risk).toBe(false);
    });
  });

  // ── markMilestoneSeen ──────────────────────────────────────────────────────

  describe('markMilestoneSeen', () => {
    it('issues UPDATE with CASE WHEN for user_a or user_b', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await service.markMilestoneSeen(USER_A, CONN_ID, 7);

      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('CASE WHEN dc.user_a_id = $1 THEN true ELSE sm.seen_by_a END');
      expect(sql).toContain('CASE WHEN dc.user_b_id = $1 THEN true ELSE sm.seen_by_b END');
      expect(params[0]).toBe(USER_A);
      expect(params[1]).toBe(CONN_ID);
      expect(params[2]).toBe(7);
    });
  });
});

// ── Pure helper function tests ─────────────────────────────────────────────

describe('toISTDate', () => {
  it('converts UTC timestamp to IST calendar date string', () => {
    // 2026-05-20T20:00:00Z = 2026-05-21T01:30:00 IST → '2026-05-21'
    expect(toISTDate(new Date('2026-05-20T20:00:00Z'))).toBe('2026-05-21');
  });

  it('does not advance date for early UTC hours that are still same IST day', () => {
    // 2026-05-20T05:00:00Z = 2026-05-20T10:30:00 IST → '2026-05-20'
    expect(toISTDate(new Date('2026-05-20T05:00:00Z'))).toBe('2026-05-20');
  });
});

describe('diffInCalendarDays', () => {
  it('returns 1 for consecutive days', () => {
    expect(diffInCalendarDays('2026-05-20', '2026-05-19')).toBe(1);
  });

  it('returns 0 for the same day', () => {
    expect(diffInCalendarDays('2026-05-20', '2026-05-20')).toBe(0);
  });

  it('returns negative for past dates', () => {
    expect(diffInCalendarDays('2026-05-19', '2026-05-20')).toBe(-1);
  });

  it('correctly handles month boundaries', () => {
    expect(diffInCalendarDays('2026-06-01', '2026-05-31')).toBe(1);
    expect(diffInCalendarDays('2027-01-01', '2026-12-31')).toBe(1);
  });
});

describe('computeWeather', () => {
  it.each([
    [30, 0, 'sunny'],
    [30, 2, 'sunny'],
    [30, 3, 'partly_cloudy'],
    [15, 2, 'partly_cloudy'],
    [14, 3, 'partly_cloudy'],
    [5,  4, 'cloudy'],
    [3,  5, 'cloudy'],
    [3,  6, 'dormant'],
    [2,  1, 'dormant'],
    [30, 31, 'dormant'],
  ])(
    'streak=%i daysSince=%i → %s',
    (streak, days, expected) => {
      expect(computeWeather(streak, days)).toBe(expected);
    },
  );
});
