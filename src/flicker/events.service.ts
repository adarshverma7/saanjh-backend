import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject, merge, interval } from 'rxjs';
import { map, finalize } from 'rxjs/operators';

// ── Typed event union ────────────────────────────────────────────────────────

export type SaanjhEvent =
  | { type: 'flicker_received'; flicker_id: string; sender_name: string; sent_at: string }
  | { type: 'mutual_reveal'; mutual_at: string }
  | {
      type: 'new_entry';
      entry_id: string;
      author_id: string;
      entry_type: string;
      duration_seconds: number | null;
      media_url: string | null;         // null for text entries
      thumbnail_url: string | null;
      url_expires_at: string | null;    // null for text entries
    }
  | { type: 'transcription_ready'; entry_id: string; transcription: string }
  | { type: 'heartbeat' };

// ── EventsService ─────────────────────────────────────────────────────────────

/**
 * Maintains per-user SSE streams using RxJS Subjects.
 *
 * Key design decisions:
 *  - One Subject per (userId, connectionId) subscriber — not shared.
 *    This means each SSE connection gets its own Subject, making cleanup safe.
 *  - Map key: `${userId}:${connectionId}` → Set<Subject>.
 *    Supports multiple simultaneous connections per user (e.g., two devices).
 *  - `finalize()` removes the Subject from the Set when the SSE client disconnects.
 *  - Heartbeat every 25 s prevents proxy/load-balancer timeouts.
 *
 * Single-server limitation:
 * TODO: When running multiple API instances, replace the in-memory Subject map
 * with Redis pub/sub. Each instance subscribes to 'saanjh:user:{userId}' channel
 * and publishes events there. Any instance can broadcast to any user regardless
 * of which server holds their SSE connection.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  // key = `${userId}:${connectionId}` → Set of active Subjects for that stream
  private readonly streams = new Map<string, Set<Subject<MessageEvent>>>();

  // ── Subscribe ────────────────────────────────────────────────────────────────

  /**
   * Returns an Observable that emits SSE events for the given user+connection pair.
   * Called by the controller's @Sse endpoint.
   * Each call creates a new Subject — safe for multiple simultaneous connections.
   */
  getStream(userId: string, connectionId: string): Observable<MessageEvent> {
    const key = this.key(userId, connectionId);
    const subject = new Subject<MessageEvent>();

    // Register this Subject
    if (!this.streams.has(key)) {
      this.streams.set(key, new Set());
    }
    this.streams.get(key)!.add(subject);

    this.logger.debug(`SSE stream opened: ${key} (active: ${this.streams.get(key)!.size})`);

    // Heartbeat merged with the event stream
    const heartbeat$ = interval(25_000).pipe(
      map(() => ({ data: { type: 'heartbeat' } }) as MessageEvent),
    );

    return merge(subject.asObservable(), heartbeat$).pipe(
      finalize(() => {
        // Called when the SSE connection closes (client disconnect or server close)
        const set = this.streams.get(key);
        if (set) {
          set.delete(subject);
          if (set.size === 0) {
            this.streams.delete(key);
          }
        }
        this.logger.debug(`SSE stream closed: ${key}`);
        subject.complete();
      }),
    );
  }

  // ── Publish ───────────────────────────────────────────────────────────────────

  /**
   * Pushes an event to all active SSE connections for the given user+connection.
   * No-op if the user has no active SSE connections (they're offline — FCM handles it).
   */
  push(userId: string, connectionId: string, event: SaanjhEvent): void {
    const key = this.key(userId, connectionId);
    const subjects = this.streams.get(key);
    if (!subjects?.size) return;

    const msg = { data: event } as MessageEvent;
    subjects.forEach((s) => {
      try {
        s.next(msg);
      } catch {
        // Subject may have been completed concurrently — ignore
      }
    });
  }

  /**
   * Pushes an event to both users of a connection.
   * Used for mutual reveal — both users need to receive the event simultaneously.
   */
  broadcastToConnection(
    connectionId: string,
    userAId: string,
    userBId: string,
    event: SaanjhEvent,
  ): void {
    this.push(userAId, connectionId, event);
    this.push(userBId, connectionId, event);
  }

  /**
   * Returns true if the user currently has at least one active SSE connection.
   * Used to decide whether to send push notification (offline) or rely on SSE (online).
   */
  isOnline(userId: string, connectionId: string): boolean {
    return (this.streams.get(this.key(userId, connectionId))?.size ?? 0) > 0;
  }

  /** Total active SSE streams — useful for monitoring. */
  get activeStreamCount(): number {
    let total = 0;
    this.streams.forEach((s) => (total += s.size));
    return total;
  }

  private key(userId: string, connectionId: string): string {
    return `${userId}:${connectionId}`;
  }
}
