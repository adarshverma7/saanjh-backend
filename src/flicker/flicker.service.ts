import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { EventsService } from './events.service';
import { TooManyRequestsException } from '../shared/exceptions/too-many-requests.exception';
import { toISTDate } from '../streaks/streaks.service';

// ── Public interfaces ────────────────────────────────────────────────────────

export interface FlickerResult {
  flicker_id: string;
  is_mutual: boolean;
  mutual_at: Date | null;
  window_closes_at: Date;
  /** True if the partner has already flickered today, regardless of the 5-min window. */
  partner_flickered_today: boolean;
}

export interface FlickerStatus {
  my_last_flicker_at: Date | null;
  partner_last_flicker_at: Date | null;
  is_mutual: boolean;
  window_closes_at: Date | null;
  /** Authoritative relationship state for the current calendar day. */
  current_state: 'idle' | 'i_sent' | 'they_sent' | 'mutual';
}

export interface FlickerHistoryItem {
  id: string;
  connection_id: string;
  sender_id: string;
  receiver_id: string;
  sent_at: Date;
  is_mutual: boolean;
  mutual_at: Date | null;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface DbFlicker {
  id: string;
  connection_id: string;
  sender_id: string;
  receiver_id: string;
  sent_at: Date;
  is_mutual: boolean;
  mutual_at: Date | null;
  mutual_window_secs: number;
}

interface RateLimitRow { count: string }

/** 5-minute mutual reveal window in seconds — drives the "reveal" animation only. */
const MUTUAL_WINDOW_SECS = 300;

/**
 * The canonical, symmetric state of one Flicker relationship for the current
 * IST day. Computed from a single DB read so both users can never disagree:
 * every SSE payload and every status response is derived from this one object.
 */
export interface RelationshipState {
  user_a_id: string;
  user_b_id: string;
  a_last_flicker_at: Date | null;
  b_last_flicker_at: Date | null;
  is_mutual: boolean;
  /** Monotonic version — max(sent_at) of the pair today. Lets clients drop stale events. */
  version: number;
}

@Injectable()
export class FlickerService {
  private readonly logger = new Logger(FlickerService.name);

  /**
   * In-memory status cache: key = `${userId}:${connectionId}`
   * TTL: 30 seconds — avoids hammering DB on every Pulse screen poll.
   */
  private readonly statusCache = new Map<
    string,
    { data: FlickerStatus; cachedAt: number }
  >();

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly eventsService: EventsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Ephemeral "partner is capturing a memory" signal — SSE only, no storage. */
  async signalRecording(
    userId: string,
    connectionId: string,
    isRecording: boolean,
    entryType: string,
  ): Promise<void> {
    const rows = await this.db.query<{ user_a_id: string; user_b_id: string }[]>(
      `SELECT user_a_id, user_b_id FROM diary_connections WHERE id = $1`,
      [connectionId],
    );
    if (!rows.length) return;
    const partnerId =
      rows[0].user_a_id === userId ? rows[0].user_b_id : rows[0].user_a_id;
    this.eventsService.push(partnerId, connectionId, {
      type: 'partner_recording',
      is_recording: isRecording,
      entry_type: entryType,
    });
  }

  // ── Send Flicker ───────────────────────────────────────────────────────────

  async sendFlicker(
    senderId: string,
    connectionId: string,
  ): Promise<FlickerResult> {
    // Rate limit: 10 flickers per user per connection per hour
    const hour = new Date().toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
    const rlKey = `flicker:${connectionId}:${senderId}:${hour}`;
    await this.enforceRateLimit(rlKey, 3600, 10, 'FLICKER_RATE_LIMIT');

    // The whole send runs in one transaction that takes a row lock on the
    // connection. Two users flickering at the same instant are therefore
    // serialised: the second one always observes the first one's row and
    // computes the mutual state correctly. Without the lock, both could miss
    // each other and neither side would ever be told it went mutual.
    const runner = this.db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    let newFlickerId: string;
    let sentAt: Date;
    let receiverId: string;
    let becameMutual = false;
    let state: RelationshipState;

    try {
      const connRows = (await runner.query(
        `SELECT user_a_id, user_b_id FROM diary_connections
         WHERE id = $1 AND status = 'active'
         FOR UPDATE`,
        [connectionId],
      )) as { user_a_id: string; user_b_id: string }[];

      if (!connRows.length) {
        throw new NotFoundException({
          error: 'CONNECTION_NOT_FOUND',
          message: 'Connection not found or inactive.',
        });
      }

      const conn = connRows[0];
      receiverId =
        conn.user_a_id === senderId ? conn.user_b_id : conn.user_a_id;

      const dayStart = istDayStart();

      // Was the relationship already mutual before this flicker? Used to decide
      // whether this send is the transition that reveals the mutual state.
      const before = await this.readState(runner, connectionId, conn, dayStart);

      const inserted = (await runner.query(
        `INSERT INTO flicker_events
           (connection_id, sender_id, receiver_id, sent_at)
         VALUES ($1, $2, $3, NOW())
         RETURNING id, sent_at`,
        [connectionId, senderId, receiverId],
      )) as { id: string; sent_at: Date }[];

      newFlickerId = inserted[0].id;
      sentAt = new Date(inserted[0].sent_at);

      state = await this.readState(runner, connectionId, conn, dayStart);
      becameMutual = state.is_mutual && !before.is_mutual;

      if (becameMutual) {
        // Mark today's pair as mutual so history reflects it. The daily state
        // itself is always derived from timestamps, never from this flag.
        await runner.query(
          `UPDATE flicker_events
           SET is_mutual = true, mutual_at = NOW()
           WHERE connection_id = $1 AND sent_at >= $2 AND is_mutual = false`,
          [connectionId, dayStart],
        );
      }

      await runner.commitTransaction();
    } catch (err: unknown) {
      await runner.rollbackTransaction().catch(() => {});
      throw err;
    } finally {
      await runner.release();
    }

    // ── Fan out the one canonical state to BOTH users ────────────────────────
    // Every client updates from the same computation, so a mutual state can
    // never appear on one device while the other still shows a single flicker.
    this.broadcastState(connectionId, state);

    const senderRows = await this.db.query<{ name: string | null }[]>(
      `SELECT name FROM users WHERE id = $1`,
      [senderId],
    );
    const senderName = senderRows[0]?.name ?? 'Someone';

    // Legacy events kept so older installed clients keep working unchanged.
    if (becameMutual) {
      this.eventsService.broadcastToConnection(connectionId, senderId, receiverId, {
        type: 'mutual_reveal',
        mutual_at: new Date().toISOString(),
      });
      this.eventEmitter.emit('flicker.mutual', {
        connectionId,
        senderId,
        receiverId,
        mutualAt: new Date(),
      });
      this.logger.log(
        `Mutual flicker: ${senderId} ↔ ${receiverId} in ${connectionId}`,
      );
    } else {
      this.eventsService.push(receiverId, connectionId, {
        type: 'flicker_received',
        flicker_id: newFlickerId,
        sender_name: senderName,
        sent_at: sentAt.toISOString(),
      });
      this.eventEmitter.emit('flicker.sent', {
        connectionId,
        senderId,
        receiverId,
        flickerId: newFlickerId,
        senderName,
      });
    }

    const perspective = perspectiveOf(state, senderId);
    return {
      flicker_id: newFlickerId,
      is_mutual: state.is_mutual,
      mutual_at: state.is_mutual ? new Date() : null,
      window_closes_at: new Date(sentAt.getTime() + MUTUAL_WINDOW_SECS * 1000),
      partner_flickered_today: perspective.partner_last_flicker_at !== null,
    };
  }

  // ── Canonical relationship state ───────────────────────────────────────────

  /**
   * Reads today's flicker timestamps for both users in one pass. This is the
   * single source of truth: sendFlicker, getFlickerStatus and every SSE payload
   * all derive from it, so the two clients cannot drift apart.
   */
  private async readState(
    runner: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    connectionId: string,
    conn: { user_a_id: string; user_b_id: string },
    dayStart: Date,
  ): Promise<RelationshipState> {
    const rows = (await runner.query(
      `SELECT sender_id, MAX(sent_at) AS last_at
       FROM flicker_events
       WHERE connection_id = $1 AND sent_at >= $2
       GROUP BY sender_id`,
      [connectionId, dayStart],
    )) as { sender_id: string; last_at: Date }[];

    let aAt: Date | null = null;
    let bAt: Date | null = null;
    for (const r of rows) {
      if (r.sender_id === conn.user_a_id) aAt = new Date(r.last_at);
      if (r.sender_id === conn.user_b_id) bAt = new Date(r.last_at);
    }

    return {
      user_a_id: conn.user_a_id,
      user_b_id: conn.user_b_id,
      a_last_flicker_at: aAt,
      b_last_flicker_at: bAt,
      is_mutual: aAt !== null && bAt !== null,
      version: Math.max(aAt?.getTime() ?? 0, bAt?.getTime() ?? 0),
    };
  }

  /** Loads the canonical state for a connection outside a transaction. */
  private async loadState(connectionId: string): Promise<RelationshipState> {
    const connRows = await this.db.query<
      { user_a_id: string; user_b_id: string }[]
    >(
      `SELECT user_a_id, user_b_id FROM diary_connections WHERE id = $1`,
      [connectionId],
    );
    if (!connRows.length) {
      throw new NotFoundException({
        error: 'CONNECTION_NOT_FOUND',
        message: 'Connection not found.',
      });
    }
    return this.readState(this.db, connectionId, connRows[0], istDayStart());
  }

  /**
   * Pushes each user their own view of the same canonical state, and drops
   * both cached statuses so any follow-up poll agrees with what was just sent.
   */
  private broadcastState(connectionId: string, state: RelationshipState): void {
    this.statusCache.delete(`${state.user_a_id}:${connectionId}`);
    this.statusCache.delete(`${state.user_b_id}:${connectionId}`);

    for (const userId of [state.user_a_id, state.user_b_id]) {
      const p = perspectiveOf(state, userId);
      this.eventsService.push(userId, connectionId, {
        type: 'flicker_state',
        connection_id: connectionId,
        current_state: p.current_state,
        is_mutual: state.is_mutual,
        my_last_flicker_at: p.my_last_flicker_at?.toISOString() ?? null,
        partner_last_flicker_at:
          p.partner_last_flicker_at?.toISOString() ?? null,
        version: state.version,
      });
    }
  }

  // ── Flicker Status ──────────────────────────────────────────────────────────

  async getFlickerStatus(
    userId: string,
    connectionId: string,
  ): Promise<FlickerStatus> {
    const cacheKey = `${userId}:${connectionId}`;
    const cached = this.statusCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < 30_000) {
      return cached.data;
    }

    // Same canonical computation the SSE payloads use — a poll can therefore
    // never contradict an event the client already applied.
    const state = await this.loadState(connectionId);
    const p = perspectiveOf(state, userId);

    // Active mutual-reveal window: only while we've sent but it isn't mutual yet.
    let windowClosesAt: Date | null = null;
    if (p.my_last_flicker_at && !state.is_mutual) {
      const windowEnd =
        p.my_last_flicker_at.getTime() + MUTUAL_WINDOW_SECS * 1000;
      if (windowEnd > Date.now()) windowClosesAt = new Date(windowEnd);
    }

    const data: FlickerStatus = {
      my_last_flicker_at: p.my_last_flicker_at,
      partner_last_flicker_at: p.partner_last_flicker_at,
      is_mutual: state.is_mutual,
      window_closes_at: windowClosesAt,
      current_state: p.current_state,
    };

    this.statusCache.set(cacheKey, { data, cachedAt: Date.now() });
    return data;
  }

  // ── Flicker History ─────────────────────────────────────────────────────────

  async getFlickerHistory(
    userId: string,
    connectionId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ flickers: FlickerHistoryItem[]; next_cursor: string | null }> {
    const params: unknown[] = [connectionId, userId, limit + 1];
    let cursorWhere = '';

    if (cursor) {
      try {
        const decoded = JSON.parse(
          Buffer.from(cursor, 'base64url').toString('utf8'),
        ) as { t: string; i: string };
        params.push(new Date(decoded.t), decoded.i);
        const p4 = params.length - 1;
        const p5 = params.length;
        cursorWhere = `AND (sent_at < $${p4} OR (sent_at = $${p4} AND id < $${p5}))`;
      } catch {
        // Invalid cursor — ignore, return from start
      }
    }

    const rows = await this.db.query<DbFlicker[]>(
      `SELECT id, connection_id, sender_id, receiver_id,
              sent_at, is_mutual, mutual_at
       FROM flicker_events
       WHERE connection_id = $1
         AND (sender_id = $2 OR receiver_id = $2)
         ${cursorWhere}
       ORDER BY sent_at DESC, id DESC
       LIMIT $3`,
      params,
    );

    const has_more = rows.length > limit;
    const flickers = has_more ? rows.slice(0, limit) : rows;
    const last = flickers[flickers.length - 1];

    const next_cursor =
      has_more && last
        ? Buffer.from(
            JSON.stringify({ t: last.sent_at, i: last.id }),
          ).toString('base64url')
        : null;

    return { flickers, next_cursor };
  }

  // ── SSE event bridges (from EventEmitter) ────────────────────────────────────

  /**
   * Push real-time SSE to the partner when a TEXT diary entry is created.
   * Voice/video entries get SSE pushed directly in EntriesService.confirmUpload
   * (with a pre-signed media URL). Text entries have no media so we handle them here.
   */
  @OnEvent('entry.created')
  async onEntryCreated(payload: {
    entryId: string;
    connectionId: string;
    authorId: string;
    entryType: string;
  }): Promise<void> {
    // Voice/video SSE (with signed URL) is pushed in confirmUpload — skip here.
    if (payload.entryType !== 'text') return;

    try {
      const rows = await this.db.query<{ user_a_id: string; user_b_id: string }[]>(
        `SELECT user_a_id, user_b_id FROM diary_connections WHERE id = $1`,
        [payload.connectionId],
      );
      if (!rows.length) return;

      const conn = rows[0];
      const partnerId =
        conn.user_a_id === payload.authorId ? conn.user_b_id : conn.user_a_id;

      this.eventsService.push(partnerId, payload.connectionId, {
        type: 'new_entry',
        entry_id: payload.entryId,
        author_id: payload.authorId,
        entry_type: 'text',
        duration_seconds: null,
        media_url: null,
        thumbnail_url: null,
        url_expires_at: null,
      });
    } catch (err: unknown) {
      this.logger.error('onEntryCreated SSE push failed', err);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async enforceRateLimit(
    key: string,
    windowSeconds: number,
    maxRequests: number,
    errorCode: string,
  ): Promise<void> {
    const rows = await this.db.query<RateLimitRow[]>(
      `INSERT INTO rate_limit_counters (key, count, window_start, updated_at)
       VALUES ($1, 1, NOW(), NOW())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE
           WHEN rate_limit_counters.window_start > NOW() - (INTERVAL '1 second' * $2)
           THEN rate_limit_counters.count + 1
           ELSE 1
         END,
         window_start = CASE
           WHEN rate_limit_counters.window_start > NOW() - (INTERVAL '1 second' * $2)
           THEN rate_limit_counters.window_start
           ELSE NOW()
         END,
         updated_at = NOW()
       RETURNING count`,
      [key, windowSeconds],
    );

    if (parseInt(rows[0].count, 10) > maxRequests) {
      throw new TooManyRequestsException({
        error: errorCode,
        message: 'Too many flickers. Please wait before sending another.',
      });
    }
  }
}

// ── Day boundary & perspective helpers ───────────────────────────────────────

/**
 * Start of the current IST day as an absolute instant.
 *
 * The daily cycle must be anchored to the users' timezone, not the server's.
 * Render runs in UTC, so a plain local midnight put the server a day behind
 * every client between 00:00 and 05:30 IST — the two users would then compute
 * different daily states from identical data.
 */
export function istDayStart(now: Date = new Date()): Date {
  return new Date(`${toISTDate(now)}T00:00:00+05:30`);
}

/** Projects the symmetric relationship state onto one user's point of view. */
export function perspectiveOf(
  state: RelationshipState,
  userId: string,
): {
  my_last_flicker_at: Date | null;
  partner_last_flicker_at: Date | null;
  current_state: FlickerStatus['current_state'];
} {
  const isA = state.user_a_id === userId;
  const mine = isA ? state.a_last_flicker_at : state.b_last_flicker_at;
  const theirs = isA ? state.b_last_flicker_at : state.a_last_flicker_at;

  return {
    my_last_flicker_at: mine,
    partner_last_flicker_at: theirs,
    current_state:
      mine && theirs ? 'mutual' : mine ? 'i_sent' : theirs ? 'they_sent' : 'idle',
  };
}
