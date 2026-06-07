import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { EventsService } from './events.service';
import { TooManyRequestsException } from '../shared/exceptions/too-many-requests.exception';

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

/** 5-minute mutual reveal window in seconds */
const MUTUAL_WINDOW_SECS = 300;

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

  // ── Send Flicker ───────────────────────────────────────────────────────────

  async sendFlicker(
    senderId: string,
    connectionId: string,
  ): Promise<FlickerResult> {
    // Rate limit: 10 flickers per user per connection per hour
    const hour = new Date().toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
    const rlKey = `flicker:${connectionId}:${senderId}:${hour}`;
    await this.enforceRateLimit(rlKey, 3600, 10, 'FLICKER_RATE_LIMIT');

    // Find the receiver (the other user in this connection)
    const connRows = await this.db.query<
      { user_a_id: string; user_b_id: string }[]
    >(
      `SELECT user_a_id, user_b_id FROM diary_connections
       WHERE id = $1 AND status = 'active'`,
      [connectionId],
    );

    if (!connRows.length) {
      throw new NotFoundException({
        error: 'CONNECTION_NOT_FOUND',
        message: 'Connection not found or inactive.',
      });
    }

    const conn = connRows[0];
    const receiverId =
      conn.user_a_id === senderId ? conn.user_b_id : conn.user_a_id;

    // Insert flicker event
    const flickerRows = await this.db.query<DbFlicker[]>(
      `INSERT INTO flicker_events
         (connection_id, sender_id, receiver_id, sent_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id, connection_id, sender_id, receiver_id, sent_at,
                 is_mutual, mutual_at, mutual_window_secs`,
      [connectionId, senderId, receiverId],
    );

    const newFlicker = flickerRows[0];
    const sentAt = new Date(newFlicker.sent_at);
    const windowClosesAt = new Date(
      sentAt.getTime() + MUTUAL_WINDOW_SECS * 1000,
    );

    // ── Check mutual reveal ────────────────────────────────────────────────────
    // Did the receiver send a flicker to us within the last 5 minutes?
    const mutualRows = await this.db.query<{ id: string }[]>(
      `SELECT id FROM flicker_events
       WHERE sender_id = $1
         AND receiver_id = $2
         AND connection_id = $3
         AND sent_at >= NOW() - (INTERVAL '1 second' * $4)
         AND is_mutual = false
       LIMIT 1`,
      [receiverId, senderId, connectionId, MUTUAL_WINDOW_SECS],
    );

    // Did the partner flicker us at any point today (regardless of mutual window)?
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const partnerTodayRows = await this.db.query<{ id: string }[]>(
      `SELECT id FROM flicker_events
       WHERE sender_id = $1 AND receiver_id = $2
         AND connection_id = $3 AND sent_at >= $4
       LIMIT 1`,
      [receiverId, senderId, connectionId, startOfDay],
    );
    const partnerFlickeredToday = partnerTodayRows.length > 0;

    if (mutualRows.length) {
      // ── Mutual reveal ──────────────────────────────────────────────────────
      const mutualAt = new Date();

      await this.db.query(
        `UPDATE flicker_events
         SET is_mutual = true, mutual_at = $1
         WHERE id = ANY($2::uuid[])`,
        [mutualAt, [newFlicker.id, mutualRows[0].id]],
      );

      // Invalidate status cache for both users
      this.statusCache.delete(`${senderId}:${connectionId}`);
      this.statusCache.delete(`${receiverId}:${connectionId}`);

      // Push real-time SSE to both users simultaneously
      const mutualEvent = {
        type: 'mutual_reveal' as const,
        mutual_at: mutualAt.toISOString(),
      };
      this.eventsService.broadcastToConnection(
        connectionId,
        senderId,
        receiverId,
        mutualEvent,
      );

      // Emit for NotificationWorker (Prompt 09)
      this.eventEmitter.emit('flicker.mutual', {
        connectionId,
        senderId,
        receiverId,
        mutualAt,
      });

      this.logger.log(
        `Mutual flicker: ${senderId} ↔ ${receiverId} in ${connectionId}`,
      );

      return {
        flicker_id: newFlicker.id,
        is_mutual: true,
        mutual_at: mutualAt,
        window_closes_at: windowClosesAt,
        partner_flickered_today: true,
      };
    }

    // ── Non-mutual: notify receiver ────────────────────────────────────────────

    // Fetch sender's display name for the SSE event
    const senderRows = await this.db.query<{ name: string | null }[]>(
      `SELECT name FROM users WHERE id = $1`,
      [senderId],
    );
    const senderName = senderRows[0]?.name ?? 'Someone';

    // Push real-time SSE to receiver (if online)
    this.eventsService.push(receiverId, connectionId, {
      type: 'flicker_received',
      flicker_id: newFlicker.id,
      sender_name: senderName,
      sent_at: sentAt.toISOString(),
    });

    // Invalidate status cache
    this.statusCache.delete(`${senderId}:${connectionId}`);
    this.statusCache.delete(`${receiverId}:${connectionId}`);

    // Emit for NotificationWorker (Prompt 09)
    this.eventEmitter.emit('flicker.sent', {
      connectionId,
      senderId,
      receiverId,
      flickerId: newFlicker.id,
      senderName,
    });

    return {
      flicker_id: newFlicker.id,
      is_mutual: false,
      mutual_at: null,
      window_closes_at: windowClosesAt,
      partner_flickered_today: partnerFlickeredToday,
    };
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

    // Determine partner
    const connRows = await this.db.query<
      { user_a_id: string; user_b_id: string }[]
    >(
      `SELECT user_a_id, user_b_id FROM diary_connections WHERE id = $1`,
      [connectionId],
    );

    if (!connRows.length) {
      throw new NotFoundException({ error: 'CONNECTION_NOT_FOUND', message: 'Connection not found.' });
    }

    const conn = connRows[0];
    const partnerId =
      conn.user_a_id === userId ? conn.user_b_id : conn.user_a_id;

    // My latest flicker to partner
    const myRows = await this.db.query<{ sent_at: Date; is_mutual: boolean }[]>(
      `SELECT sent_at, is_mutual FROM flicker_events
       WHERE sender_id = $1 AND receiver_id = $2 AND connection_id = $3
       ORDER BY sent_at DESC LIMIT 1`,
      [userId, partnerId, connectionId],
    );

    // Partner's latest flicker to me
    const partnerRows = await this.db.query<{ sent_at: Date }[]>(
      `SELECT sent_at FROM flicker_events
       WHERE sender_id = $1 AND receiver_id = $2 AND connection_id = $3
       ORDER BY sent_at DESC LIMIT 1`,
      [partnerId, userId, connectionId],
    );

    const myLast = myRows[0] ?? null;
    const partnerLast = partnerRows[0] ?? null;

    const nowMs = Date.now();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    // "Mutual today" means both users have flickered at any point today.
    // The DB is_mutual flag only marks the 5-min real-time window — don't use it
    // for the daily mutual display state.
    const myFlickeredToday = myLast && new Date(myLast.sent_at) >= startOfDay;
    const partnerFlickeredToday = partnerLast && new Date(partnerLast.sent_at) >= startOfDay;
    const isMutual = !!(myFlickeredToday && partnerFlickeredToday);

    // Active mutual-reveal window: only relevant if we sent recently but haven't become mutual yet.
    let windowClosesAt: Date | null = null;
    if (myLast && !isMutual) {
      const windowEnd = new Date(myLast.sent_at).getTime() + MUTUAL_WINDOW_SECS * 1000;
      if (windowEnd > nowMs) {
        windowClosesAt = new Date(windowEnd);
      }
    }

    const currentState: FlickerStatus['current_state'] =
      isMutual              ? 'mutual'
      : myFlickeredToday    ? 'i_sent'
      : partnerFlickeredToday ? 'they_sent'
      : 'idle';

    const data: FlickerStatus = {
      my_last_flicker_at: myLast ? new Date(myLast.sent_at) : null,
      partner_last_flicker_at: partnerLast ? new Date(partnerLast.sent_at) : null,
      is_mutual: isMutual,
      window_closes_at: windowClosesAt,
      current_state: currentState,
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

  /**
   * When TranscriptionWorker finishes a voice note, push SSE to both users
   * so the transcription text appears live without a page refresh.
   * Emitted by the TranscriptionWorker (Prompt 09).
   */
  @OnEvent('transcription.ready')
  async onTranscriptionReady(payload: {
    entryId: string;
    connectionId: string;
    userAId: string;
    userBId: string;
  }): Promise<void> {
    try {
      this.eventsService.broadcastToConnection(
        payload.connectionId,
        payload.userAId,
        payload.userBId,
        { type: 'transcription_ready', entry_id: payload.entryId },
      );
    } catch (err: unknown) {
      this.logger.error('onTranscriptionReady SSE push failed', err);
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
