import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

// ── Public interfaces ────────────────────────────────────────────────────────

export interface MilestoneInfo {
  days: number;
  achieved_at: Date;
  seen_by_me: boolean;
}

export interface StreakData {
  current_streak: number;
  longest_streak: number;
  streak_started_at: string | null;
  days_since_last_entry: number | null;
  at_risk: boolean;
  total_entry_days: number;
  milestones: MilestoneInfo[];
}

interface ConnRow {
  user_a_id: string;
  user_b_id: string;
  streak_count: number;
  longest_streak: number;
  streak_last_date: string | null;
  streak_started_at: string | null;
}

interface MilestoneRow {
  milestone_days: number;
  achieved_at: Date;
  seen_by_a: boolean;
  seen_by_b: boolean;
}

const MILESTONE_DAYS = [7, 30, 60, 100, 200, 365];

@Injectable()
export class StreaksService {
  private readonly logger = new Logger(StreaksService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Core streak update ─────────────────────────────────────────────────────

  /**
   * Updates the streak for a connection after a new diary entry is created.
   * Called by EntriesService after every successful entry creation.
   *
   * All dates are computed in IST (UTC+5:30). Uses SELECT FOR UPDATE to
   * prevent race conditions when both users post at the same moment.
   */
  async onNewEntry(connectionId: string, recordedAt: Date): Promise<void> {
    const today = toISTDate(recordedAt);

    const connRows = await this.db.query<ConnRow[]>(
      `SELECT user_a_id, user_b_id, streak_count, longest_streak,
              streak_last_date, streak_started_at
       FROM diary_connections
       WHERE id = $1
       FOR UPDATE`,
      [connectionId],
    );

    if (!connRows.length) return;
    const conn = connRows[0];

    if (!conn.streak_last_date) {
      // First entry ever for this connection
      await this.db.query(
        `UPDATE diary_connections
         SET streak_count     = 1,
             streak_last_date  = $1,
             streak_started_at = $1,
             longest_streak    = 1,
             diary_weather     = 'cloudy',
             updated_at        = NOW()
         WHERE id = $2`,
        [today, connectionId],
      );
      return;
    }

    const daysDiff = diffInCalendarDays(today, conn.streak_last_date);

    if (daysDiff === 0) {
      // Same IST day — already counted, nothing to update
      return;
    }

    if (daysDiff === 1) {
      // Consecutive day — extend streak
      const newStreak = Number(conn.streak_count) + 1;
      const newLongest = Math.max(newStreak, Number(conn.longest_streak));
      const weather = computeWeather(newStreak, 1);

      await this.db.query(
        `UPDATE diary_connections
         SET streak_count    = $1,
             streak_last_date = $2,
             longest_streak   = $3,
             diary_weather    = $4,
             updated_at       = NOW()
         WHERE id = $5`,
        [newStreak, today, newLongest, weather, connectionId],
      );

      await this.checkMilestones(connectionId, newStreak);
    } else {
      // Gap > 1 day — streak broken, reset to 1
      await this.db.query(
        `UPDATE diary_connections
         SET streak_count     = 1,
             streak_last_date  = $1,
             streak_started_at = $1,
             diary_weather     = 'partly_cloudy',
             updated_at        = NOW()
         WHERE id = $2`,
        [today, connectionId],
      );
    }
  }

  // ── Milestone detection ────────────────────────────────────────────────────

  async checkMilestones(
    connectionId: string,
    streakCount: number,
  ): Promise<void> {
    if (!MILESTONE_DAYS.includes(streakCount)) return;

    // Idempotent INSERT — safe to call on every streak increment
    const inserted = await this.db.query<{ id: string }[]>(
      `INSERT INTO streak_milestones (connection_id, milestone_days)
       VALUES ($1, $2)
       ON CONFLICT (connection_id, milestone_days) DO NOTHING
       RETURNING id`,
      [connectionId, streakCount],
    );

    if (inserted.length) {
      this.logger.log(
        `Milestone ${streakCount} days reached for connection ${connectionId}`,
      );
      // NotificationWorker handles push to both users via @OnEvent
      this.eventEmitter.emit('streak.milestone', {
        connectionId,
        milestoneDay: streakCount,
      });
    }
  }

  // ── Read streak data ───────────────────────────────────────────────────────

  async getStreakData(userId: string, connectionId: string): Promise<StreakData> {
    const connRows = await this.db.query<ConnRow[]>(
      `SELECT user_a_id, user_b_id, streak_count, longest_streak,
              streak_last_date, streak_started_at
       FROM diary_connections WHERE id = $1`,
      [connectionId],
    );

    const conn = connRows[0] ?? null;
    const todayIST = toISTDate(new Date());

    const at_risk =
      conn !== null &&
      Number(conn.streak_count) > 0 &&
      conn.streak_last_date !== null &&
      conn.streak_last_date < todayIST;

    const days_since_last_entry =
      conn?.streak_last_date != null
        ? diffInCalendarDays(todayIST, conn.streak_last_date)
        : null;

    // Distinct IST calendar days with at least one entry
    const daysRows = await this.db.query<{ total_days: string }[]>(
      `SELECT COUNT(DISTINCT DATE(recorded_at AT TIME ZONE 'Asia/Kolkata'))::text
         AS total_days
       FROM diary_entries
       WHERE connection_id = $1 AND deleted_at IS NULL`,
      [connectionId],
    );
    const total_entry_days = parseInt(daysRows[0]?.total_days ?? '0', 10);

    // Milestones — mark which ones this user has already seen
    const milestoneRows = await this.db.query<MilestoneRow[]>(
      `SELECT milestone_days, achieved_at, seen_by_a, seen_by_b
       FROM streak_milestones
       WHERE connection_id = $1
       ORDER BY milestone_days ASC`,
      [connectionId],
    );

    const isUserA = conn?.user_a_id === userId;

    const milestones: MilestoneInfo[] = milestoneRows.map((m) => ({
      days: m.milestone_days,
      achieved_at: m.achieved_at,
      seen_by_me: isUserA ? m.seen_by_a : m.seen_by_b,
    }));

    return {
      current_streak: Number(conn?.streak_count ?? 0),
      longest_streak: Number(conn?.longest_streak ?? 0),
      streak_started_at: conn?.streak_started_at ?? null,
      days_since_last_entry,
      at_risk,
      total_entry_days,
      milestones,
    };
  }

  // ── Mark milestone seen ────────────────────────────────────────────────────

  async markMilestoneSeen(
    userId: string,
    connectionId: string,
    days: number,
  ): Promise<void> {
    await this.db.query(
      `UPDATE streak_milestones sm
       SET seen_by_a = CASE WHEN dc.user_a_id = $1 THEN true ELSE sm.seen_by_a END,
           seen_by_b = CASE WHEN dc.user_b_id = $1 THEN true ELSE sm.seen_by_b END
       FROM diary_connections dc
       WHERE sm.connection_id = $2
         AND sm.milestone_days = $3
         AND dc.id = $2`,
      [userId, connectionId, days],
    );
  }
}

// ── Module-level helpers (exported for reuse and testing) ─────────────────

/**
 * Converts a UTC Date to an IST calendar date string 'YYYY-MM-DD'.
 * IST = UTC+5:30 (fixed offset, no DST).
 */
export function toISTDate(date: Date): string {
  const IST_MS = 5.5 * 60 * 60 * 1000;
  return new Date(date.getTime() + IST_MS).toISOString().slice(0, 10);
}

/**
 * Calendar-day difference between two 'YYYY-MM-DD' date strings.
 * Returns positive when a is after b.
 */
export function diffInCalendarDays(a: string, b: string): number {
  return Math.round(
    (new Date(a).getTime() - new Date(b).getTime()) / (1000 * 60 * 60 * 24),
  );
}

/**
 * Diary weather from streak count and days since last entry.
 */
export function computeWeather(streakCount: number, daysSinceLast: number): string {
  if (daysSinceLast > 30) return 'dormant';
  if (streakCount >= 30 && daysSinceLast <= 2) return 'sunny';
  if (streakCount >= 14 && daysSinceLast <= 3) return 'partly_cloudy';
  if (streakCount >= 3 && daysSinceLast <= 5) return 'cloudy';
  return 'dormant';
}
