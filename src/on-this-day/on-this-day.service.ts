import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

// ── Public interfaces ────────────────────────────────────────────────────────

export interface OnThisDayEntry {
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

export interface OnThisDayResult {
  entries: OnThisDayEntry[];
  years: number[];        // unique IST years that have entries on this date
  has_entries: boolean;
  month: number;          // IST month used for the query (1–12)
  day: number;            // IST day used for the query (1–31)
}

@Injectable()
export class OnThisDayService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
  ) {}

  /**
   * Returns diary entries recorded on the same calendar date (month + day)
   * in PAST years. Never returns entries from the current year.
   *
   * All date comparisons are done in IST (Asia/Kolkata = UTC+5:30).
   * A recording at 11:00 PM IST must surface on its IST date, not the UTC date.
   *
   * @param date Optional 'YYYY-MM-DD' string. Defaults to IST today.
   */
  async getOnThisDay(
    _userId: string,
    connectionId: string,
    date?: string,
  ): Promise<OnThisDayResult> {
    let month: number;
    let day: number;

    if (date) {
      // Validate provided date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new BadRequestException({
          error: 'INVALID_DATE_FORMAT',
          message: 'date must be in YYYY-MM-DD format',
        });
      }
      const parsed = new Date(date + 'T00:00:00+05:30'); // treat as IST date
      if (isNaN(parsed.getTime())) {
        throw new BadRequestException({
          error: 'INVALID_DATE',
          message: 'Invalid date value',
        });
      }
      month = parsed.getMonth() + 1;
      day = parsed.getDate();
    } else {
      // Use today in IST timezone
      // toLocaleString with 'Asia/Kolkata' gives us a string representing the
      // current wall-clock time in IST, which we parse as a local Date.
      const istNow = new Date(
        new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
      );
      month = istNow.getMonth() + 1;
      day = istNow.getDate();
    }

    // ── Main query ────────────────────────────────────────────────────────────
    //
    // Uses EXTRACT with AT TIME ZONE 'Asia/Kolkata' to ensure IST dates.
    // Note: idx_entries_anniversary was built on UTC EXTRACT values.
    // For MVP (few entries per connection), the sequential scan is fast enough.
    // At scale, create an IST-aware functional index:
    //   CREATE INDEX ON diary_entries(connection_id,
    //     EXTRACT(MONTH FROM recorded_at AT TIME ZONE 'Asia/Kolkata')::INT,
    //     EXTRACT(DAY FROM recorded_at AT TIME ZONE 'Asia/Kolkata')::INT)
    //   WHERE deleted_at IS NULL;
    //
    // "Past years only" condition: exclude any entry from the current IST year.
    const entries = await this.db.query<OnThisDayEntry[]>(
      `SELECT id, connection_id, author_id, entry_type,
              duration_seconds, transcription, transcription_status,
              mood, is_starred, starred_at, play_count,
              recorded_at, created_at
       FROM diary_entries
       WHERE connection_id = $1
         AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM recorded_at AT TIME ZONE 'Asia/Kolkata')::INT = $2
         AND EXTRACT(DAY   FROM recorded_at AT TIME ZONE 'Asia/Kolkata')::INT = $3
         AND EXTRACT(YEAR  FROM recorded_at AT TIME ZONE 'Asia/Kolkata')::INT
             < EXTRACT(YEAR FROM NOW() AT TIME ZONE 'Asia/Kolkata')::INT
       ORDER BY recorded_at DESC`,
      [connectionId, month, day],
    );

    // Extract unique IST years from the result set
    const years = [
      ...new Set(
        entries.map((e) => {
          // Convert stored UTC timestamp to IST year
          const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
          return new Date(
            new Date(e.recorded_at).getTime() + IST_OFFSET_MS,
          ).getUTCFullYear();
        }),
      ),
    ].sort((a, b) => b - a); // most recent year first

    return {
      entries,
      years,
      has_entries: entries.length > 0,
      month,
      day,
    };
  }
}
