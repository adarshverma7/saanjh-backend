import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  encodeStarredCursor,
  decodeStarredCursor,
} from '../shared/helpers/pagination.helper';

// ── Public interfaces ────────────────────────────────────────────────────────

export interface JarEntry {
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

export interface SurfaceResult {
  entry: JarEntry | null;
  total_starred: number;
  surfaced: boolean;
}

export interface StarredPageResult {
  entries: JarEntry[];
  next_cursor: string | null;
  has_more: boolean;
  total_starred: number;
}

// ── MemoryJarService ──────────────────────────────────────────────────────────

@Injectable()
export class MemoryJarService {
  /** Time-gate window: surface at most once per 4 hours per connection */
  private static readonly GATE_HOURS = 4;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
  ) {}

  // ── Surface a random memory ────────────────────────────────────────────────

  /**
   * Called on home screen open.
   *
   * Time gate: returns surfaced=false if called within 4 hours of the last
   * surface for this user+connection pair. This makes the Memory Jar feel
   * like a daily ritual rather than an intrusive pop-up.
   *
   * Selection: ORDER BY RANDOM() is fine at MVP scale.
   * TODO: At 100k+ starred entries, switch to:
   *   ORDER BY starred_at DESC OFFSET FLOOR(RANDOM() * total_count) LIMIT 1
   * to avoid a full-table shuffle.
   */
  async surfaceMemory(
    userId: string,
    connectionId: string,
  ): Promise<SurfaceResult> {
    const gateKey = `jar_gate:${userId}:${connectionId}`;

    // Always return total_starred even when within the gate
    const totalRows = await this.db.query<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
       FROM diary_entries
       WHERE connection_id = $1 AND is_starred = true AND deleted_at IS NULL`,
      [connectionId],
    );
    const total_starred = parseInt(totalRows[0]?.count ?? '0', 10);

    if (total_starred === 0) {
      return { entry: null, total_starred: 0, surfaced: false };
    }

    // ── Time gate check ────────────────────────────────────────────────────────
    const gateRows = await this.db.query<{ updated_at: Date }[]>(
      `SELECT updated_at FROM rate_limit_counters
       WHERE key = $1
         AND updated_at > NOW() - (INTERVAL '1 hour' * $2)`,
      [gateKey, MemoryJarService.GATE_HOURS],
    );

    if (gateRows.length) {
      // Within the 4-hour window — don't surface
      return { entry: null, total_starred, surfaced: false };
    }

    // ── Fetch a random starred entry ───────────────────────────────────────────
    const entryRows = await this.db.query<JarEntry[]>(
      `SELECT id, connection_id, author_id, entry_type,
              duration_seconds, transcription, transcription_status,
              mood, is_starred, starred_at, play_count, recorded_at, created_at
       FROM diary_entries
       WHERE connection_id = $1
         AND is_starred = true
         AND deleted_at IS NULL
       ORDER BY RANDOM()
       LIMIT 1`,
      [connectionId],
    );

    if (!entryRows.length) {
      return { entry: null, total_starred, surfaced: false };
    }

    // ── Update time gate ───────────────────────────────────────────────────────
    await this.db.query(
      `INSERT INTO rate_limit_counters (key, count, window_start, updated_at)
       VALUES ($1, 1, NOW(), NOW())
       ON CONFLICT (key) DO UPDATE SET
         count      = rate_limit_counters.count + 1,
         updated_at = NOW()`,
      [gateKey],
    );

    return { entry: entryRows[0], total_starred, surfaced: true };
  }

  // ── All starred entries (paginated) ───────────────────────────────────────

  /**
   * Returns all starred entries for the connection in reverse-star order.
   * Used by the Memory Jar screen ("View all memories").
   *
   * Pagination: cursor encodes (starred_at DESC, id DESC).
   */
  async getAllStarred(
    _userId: string,
    connectionId: string,
    limit: number,
    cursor?: string,
  ): Promise<StarredPageResult> {
    const params: unknown[] = [connectionId];
    let cursorWhere = '';

    if (cursor) {
      const decoded = decodeStarredCursor(cursor);
      if (decoded) {
        const p1 = params.length + 1;
        const p2 = params.length + 2;
        cursorWhere = `AND (starred_at < $${p1} OR (starred_at = $${p1} AND id < $${p2}))`;
        params.push(decoded.starredAt, decoded.id);
      }
    }

    // Fetch limit+1 to detect has_more
    params.push(limit + 1);
    const pLimit = params.length;

    const rows = await this.db.query<JarEntry[]>(
      `SELECT id, connection_id, author_id, entry_type,
              duration_seconds, transcription, transcription_status,
              mood, is_starred, starred_at, play_count, recorded_at, created_at
       FROM diary_entries
       WHERE connection_id = $1
         AND is_starred = true
         AND deleted_at IS NULL
         ${cursorWhere}
       ORDER BY starred_at DESC, id DESC
       LIMIT $${pLimit}`,
      params,
    );

    const totalRows = await this.db.query<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
       FROM diary_entries
       WHERE connection_id = $1 AND is_starred = true AND deleted_at IS NULL`,
      [connectionId],
    );
    const total_starred = parseInt(totalRows[0]?.count ?? '0', 10);

    const has_more = rows.length > limit;
    const entries = has_more ? rows.slice(0, limit) : rows;
    const last = entries[entries.length - 1];

    const next_cursor =
      has_more && last?.starred_at
        ? encodeStarredCursor(new Date(last.starred_at), last.id)
        : null;

    return { entries, next_cursor, has_more, total_starred };
  }
}
