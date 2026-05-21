import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

// ── Public interfaces ────────────────────────────────────────────────────────

export interface MonthData {
  year_month: string;                      // 'YYYY-MM' format
  entry_count: number;
  voice_count: number;
  video_count: number;
  mood_distribution: Record<string, number>; // { happy: 3, calm: 2, ... }
  has_milestone: boolean;                  // true if streak milestone hit this month
  node_health: number;                     // 0.0–1.0  (10 entries = full health)
}

export interface MemoryTreeData {
  months: MonthData[];
  tree_health: number;       // 0.0–1.0 recency-weighted average
  diary_weather: string;     // 'sunny' | 'partly_cloudy' | 'cloudy' | 'dormant'
  streak_count: number;
  longest_streak: number;
  total_entries: number;
  active_months: number;     // months with at least one entry
}

export interface MonthDetailResult {
  entries: MonthEntryRow[];
  month_stats: MonthStats;
}

export interface MonthStats {
  entry_count: number;
  voice_count: number;
  video_count: number;
  mood_distribution: Record<string, number>;
  node_health: number;
  has_milestone: boolean;
  year_month: string;
}

// ── Internal DB row types ────────────────────────────────────────────────────

interface AggRow {
  year_month: string;
  entry_count: string;
  voice_count: string;
  video_count: string;
  mood_happy: string;
  mood_calm: string;
  mood_thoughtful: string;
  mood_missing: string;
  mood_excited: string;
}

interface CacheRow {
  connection_id: string;
  monthly_data: MonthData[];
  total_entries: number;
  active_months: number;
  tree_health: number;
  last_computed_at: Date;
}

interface ConnRow {
  streak_count: number;
  longest_streak: number;
  diary_weather: string;
}

interface MilestoneRow {
  milestone_days: number;
  achieved_at: Date;
}

interface MonthEntryRow {
  id: string;
  connection_id: string;
  author_id: string;
  entry_type: string;
  duration_seconds: number | null;
  transcription: string | null;
  transcription_status: string;
  mood: string | null;
  is_starred: boolean;
  starred_at: Date | null;
  play_count: number;
  recorded_at: Date;
  created_at: Date;
}

// ── MemoryTreeService ────────────────────────────────────────────────────────

@Injectable()
export class MemoryTreeService {
  private readonly logger = new Logger(MemoryTreeService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Returns Memory Tree data for a connection.
   *
   * Cache strategy:
   *  - Cache valid for 10 minutes (stored in memory_tree_cache table).
   *  - Monthly aggregation (expensive) is cached; streak data is always fresh.
   *  - Cache is invalidated on every diary entry create/delete.
   *  - On cache miss: compute → upsert → return.
   */
  async getMemoryTree(
    _userId: string,
    connectionId: string,
  ): Promise<MemoryTreeData> {
    // Step 1: Check cache (valid for 10 minutes)
    const cacheRows = await this.db.query<CacheRow[]>(
      `SELECT connection_id, monthly_data, total_entries, active_months,
              tree_health, last_computed_at
       FROM memory_tree_cache
       WHERE connection_id = $1
         AND last_computed_at > NOW() - INTERVAL '10 minutes'`,
      [connectionId],
    );

    if (cacheRows.length) {
      // Cache hit — merge cached aggregation with fresh streak data
      const cache = cacheRows[0];
      const conn = await this.fetchConnRow(connectionId);
      return this.buildFromCache(cache, conn);
    }

    // Step 2: Cache miss or stale — compute fresh
    return this.computeMemoryTree(connectionId);
  }

  /**
   * Full computation of Memory Tree data.
   * Runs the monthly aggregation SQL, computes health scores, upserts cache.
   */
  async computeMemoryTree(connectionId: string): Promise<MemoryTreeData> {
    // ── Monthly aggregation ──────────────────────────────────────────────────
    const aggRows = await this.db.query<AggRow[]>(
      `SELECT
         TO_CHAR(
           DATE_TRUNC('month', recorded_at AT TIME ZONE 'Asia/Kolkata'),
           'YYYY-MM'
         ) AS year_month,
         COUNT(*)::text                                              AS entry_count,
         COUNT(*) FILTER (WHERE entry_type = 'voice')::text         AS voice_count,
         COUNT(*) FILTER (WHERE entry_type = 'video')::text         AS video_count,
         COUNT(*) FILTER (WHERE mood = 'happy')::text               AS mood_happy,
         COUNT(*) FILTER (WHERE mood = 'calm')::text                AS mood_calm,
         COUNT(*) FILTER (WHERE mood = 'thoughtful')::text          AS mood_thoughtful,
         COUNT(*) FILTER (WHERE mood = 'missing')::text             AS mood_missing,
         COUNT(*) FILTER (WHERE mood = 'excited')::text             AS mood_excited
       FROM diary_entries
       WHERE connection_id = $1 AND deleted_at IS NULL
       GROUP BY year_month
       ORDER BY year_month ASC`,
      [connectionId],
    );

    // ── Milestones ────────────────────────────────────────────────────────────
    const milestoneRows = await this.db.query<MilestoneRow[]>(
      `SELECT milestone_days, achieved_at
       FROM streak_milestones
       WHERE connection_id = $1`,
      [connectionId],
    );

    // Index milestones by year_month for O(1) lookup
    const milestonesPerMonth = new Set<string>();
    for (const m of milestoneRows) {
      const achievedAt = new Date(m.achieved_at);
      const ym = toYearMonth(achievedAt);
      milestonesPerMonth.add(ym);
    }

    // ── Build MonthData array ─────────────────────────────────────────────────
    const months: MonthData[] = aggRows.map((row) => {
      const entryCount = parseInt(row.entry_count, 10);
      return {
        year_month: row.year_month,
        entry_count: entryCount,
        voice_count: parseInt(row.voice_count, 10),
        video_count: parseInt(row.video_count, 10),
        mood_distribution: {
          happy:      parseInt(row.mood_happy, 10),
          calm:       parseInt(row.mood_calm, 10),
          thoughtful: parseInt(row.mood_thoughtful, 10),
          missing:    parseInt(row.mood_missing, 10),
          excited:    parseInt(row.mood_excited, 10),
        },
        has_milestone: milestonesPerMonth.has(row.year_month),
        // 10 entries in a month = full health (scales linearly)
        node_health: Math.min(1.0, entryCount / 10.0),
      };
    });

    // ── Recency-weighted tree_health ─────────────────────────────────────────
    // Weights: current month 0.5, prev 0.3, prev-prev 0.2
    const treeHealth = computeTreeHealth(months);

    // ── Aggregate totals ──────────────────────────────────────────────────────
    const totalEntries = months.reduce((s, m) => s + m.entry_count, 0);
    const activeMonths = months.filter((m) => m.entry_count > 0).length;

    // ── Streak + diary_weather (always fresh) ─────────────────────────────────
    const conn = await this.fetchConnRow(connectionId);

    // ── Upsert cache ──────────────────────────────────────────────────────────
    await this.db
      .query(
        `INSERT INTO memory_tree_cache
           (connection_id, monthly_data, total_entries, active_months,
            tree_health, last_computed_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (connection_id) DO UPDATE SET
           monthly_data      = EXCLUDED.monthly_data,
           total_entries     = EXCLUDED.total_entries,
           active_months     = EXCLUDED.active_months,
           tree_health       = EXCLUDED.tree_health,
           last_computed_at  = NOW()`,
        [
          connectionId,
          JSON.stringify(months),
          totalEntries,
          activeMonths,
          treeHealth.toFixed(2),
        ],
      )
      .catch((err: unknown) => {
        // Cache write failure is non-fatal — return fresh data anyway
        this.logger.warn('Memory tree cache upsert failed', err);
      });

    return {
      months,
      tree_health: treeHealth,
      diary_weather: conn?.diary_weather ?? 'dormant',
      streak_count: conn ? Number(conn.streak_count) : 0,
      longest_streak: conn ? Number(conn.longest_streak) : 0,
      total_entries: totalEntries,
      active_months: activeMonths,
    };
  }

  /**
   * Live query for month detail — does NOT use cache.
   * Returns all entries for the specified month + aggregated stats.
   */
  async getMonthDetail(
    _userId: string,
    connectionId: string,
    yearMonth: string,
    filter: string = 'all',
  ): Promise<MonthDetailResult> {
    // Validate and parse 'YYYY-MM'
    if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
      throw new BadRequestException({
        error: 'INVALID_YEAR_MONTH',
        message: 'yearMonth must be in YYYY-MM format (e.g. 2026-05)',
      });
    }

    const [year, month] = yearMonth.split('-').map(Number);
    const startDate = `${yearMonth}-01`;
    // End date = first day of next month (exclusive)
    const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

    // Build filter clause
    let filterSql = '';
    if (filter === 'voice')   filterSql = `AND entry_type = 'voice'`;
    if (filter === 'video')   filterSql = `AND entry_type = 'video'`;
    if (filter === 'starred') filterSql = `AND is_starred = true`;

    const entries = await this.db.query<MonthEntryRow[]>(
      `SELECT id, connection_id, author_id, entry_type,
              duration_seconds, transcription, transcription_status,
              mood, is_starred, starred_at, play_count, recorded_at, created_at
       FROM diary_entries
       WHERE connection_id = $1
         AND deleted_at IS NULL
         AND recorded_at AT TIME ZONE 'Asia/Kolkata' >= $2
         AND recorded_at AT TIME ZONE 'Asia/Kolkata' < $3
         ${filterSql}
       ORDER BY recorded_at DESC`,
      [connectionId, startDate, nextMonth],
    );

    // Compute stats from the full (unfiltered) set for the month header
    const allEntries = await this.db.query<AggRow[]>(
      `SELECT
         COUNT(*)::text                                         AS entry_count,
         COUNT(*) FILTER (WHERE entry_type='voice')::text      AS voice_count,
         COUNT(*) FILTER (WHERE entry_type='video')::text      AS video_count,
         COUNT(*) FILTER (WHERE mood='happy')::text            AS mood_happy,
         COUNT(*) FILTER (WHERE mood='calm')::text             AS mood_calm,
         COUNT(*) FILTER (WHERE mood='thoughtful')::text       AS mood_thoughtful,
         COUNT(*) FILTER (WHERE mood='missing')::text          AS mood_missing,
         COUNT(*) FILTER (WHERE mood='excited')::text          AS mood_excited,
         '' AS year_month
       FROM diary_entries
       WHERE connection_id = $1
         AND deleted_at IS NULL
         AND recorded_at AT TIME ZONE 'Asia/Kolkata' >= $2
         AND recorded_at AT TIME ZONE 'Asia/Kolkata' < $3`,
      [connectionId, startDate, nextMonth],
    );

    const statsRow = allEntries[0];
    const entryCount = parseInt(statsRow?.entry_count ?? '0', 10);

    // Check if a milestone was achieved this month
    const milestoneRows = await this.db.query<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
       FROM streak_milestones
       WHERE connection_id = $1
         AND DATE_TRUNC('month', achieved_at AT TIME ZONE 'Asia/Kolkata')
             = DATE_TRUNC('month', $2::timestamptz AT TIME ZONE 'Asia/Kolkata')`,
      [connectionId, `${startDate}T00:00:00Z`],
    );

    const month_stats: MonthStats = {
      year_month: yearMonth,
      entry_count: entryCount,
      voice_count: parseInt(statsRow?.voice_count ?? '0', 10),
      video_count: parseInt(statsRow?.video_count ?? '0', 10),
      mood_distribution: {
        happy:      parseInt(statsRow?.mood_happy ?? '0', 10),
        calm:       parseInt(statsRow?.mood_calm ?? '0', 10),
        thoughtful: parseInt(statsRow?.mood_thoughtful ?? '0', 10),
        missing:    parseInt(statsRow?.mood_missing ?? '0', 10),
        excited:    parseInt(statsRow?.mood_excited ?? '0', 10),
      },
      node_health: Math.min(1.0, entryCount / 10.0),
      has_milestone: parseInt(milestoneRows[0]?.count ?? '0', 10) > 0,
    };

    return { entries, month_stats };
  }

  /**
   * Invalidates the Memory Tree cache for a connection.
   * Must be called after every diary entry create or soft-delete.
   */
  async invalidateCache(connectionId: string): Promise<void> {
    await this.db
      .query(
        `DELETE FROM memory_tree_cache WHERE connection_id = $1`,
        [connectionId],
      )
      .catch((err: unknown) =>
        this.logger.warn(`Cache invalidation failed for ${connectionId}`, err),
      );
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async fetchConnRow(connectionId: string): Promise<ConnRow | null> {
    const rows = await this.db.query<ConnRow[]>(
      `SELECT streak_count, longest_streak, diary_weather
       FROM diary_connections WHERE id = $1`,
      [connectionId],
    );
    return rows[0] ?? null;
  }

  private buildFromCache(
    cache: CacheRow,
    conn: ConnRow | null,
  ): MemoryTreeData {
    return {
      months: cache.monthly_data,
      tree_health: Number(cache.tree_health),
      diary_weather: conn?.diary_weather ?? 'dormant',
      streak_count: conn ? Number(conn.streak_count) : 0,
      longest_streak: conn ? Number(conn.longest_streak) : 0,
      total_entries: Number(cache.total_entries),
      active_months: Number(cache.active_months),
    };
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────

/**
 * Recency-weighted tree health from the last 3 months.
 * Weights: current = 0.5, previous = 0.3, two months ago = 0.2.
 *
 * Falls back gracefully if fewer than 3 months of data exist.
 */
function computeTreeHealth(months: MonthData[]): number {
  if (months.length === 0) return 0.0;

  const last3 = months.slice(-3);
  const weights = [0.2, 0.3, 0.5]; // oldest → newest
  const offset = 3 - last3.length; // e.g. if only 1 month, use weight[2] = 0.5

  let weighted = 0;
  let totalWeight = 0;

  for (let i = 0; i < last3.length; i++) {
    const w = weights[offset + i];
    weighted += last3[i].node_health * w;
    totalWeight += w;
  }

  return totalWeight > 0 ? Math.round((weighted / totalWeight) * 100) / 100 : 0;
}

/**
 * Converts a Date to 'YYYY-MM' in IST timezone.
 */
function toYearMonth(date: Date): string {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  return istDate.toISOString().slice(0, 7); // 'YYYY-MM'
}

/**
 * Diary weather from streak and recency.
 * Exported for use in StreaksService (Prompt 13).
 */
export function computeDiaryWeather(
  streakCount: number,
  daysSinceLastEntry: number,
): string {
  if (daysSinceLastEntry > 30) return 'dormant';
  if (streakCount >= 30 && daysSinceLastEntry <= 2) return 'sunny';
  if (streakCount >= 14 && daysSinceLastEntry <= 3) return 'partly_cloudy';
  if (streakCount >= 3 && daysSinceLastEntry <= 5) return 'cloudy';
  return 'dormant';
}
