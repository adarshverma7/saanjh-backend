import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { TooManyRequestsException } from '../shared/exceptions/too-many-requests.exception';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { StorageService } from '../shared/storage/storage.service';
import { returningRows } from '../shared/database/query-utils';
import { StreaksService, toISTDate } from '../streaks/streaks.service';
import { EventsService } from '../flicker/events.service';
import {
  encodeCursor,
  decodeCursor,
} from '../shared/helpers/pagination.helper';
import type { UploadUrlDto } from './dto/upload-url.dto';
import type { CreateEntryDto } from './dto/create-entry.dto';
import type { ListEntriesDto } from './dto/list-entries.dto';
import type { RequestUploadDto } from './dto/request-upload.dto';
import type { ConfirmUploadDto } from './dto/confirm-upload.dto';

// ── Public types ─────────────────────────────────────────────────────────────

export interface UploadUrlResult {
  media_key: string;
  entry_id: string;
  upload_url: string;
}

export interface RequestUploadResult {
  entry_id: string;
  media_key: string;
  upload_url: string;
  expires_at: string; // ISO timestamp — Flutter must PUT before this time
}

export interface DiaryEntry {
  id: string;
  connection_id: string;
  author_id: string;
  entry_type: string;
  content: string | null;
  duration_seconds: number | null;
  file_size_bytes: number | null;
  transcription: string | null;
  transcription_status: string;
  mood: string | null;
  is_starred: boolean;
  starred_at: Date | null;
  play_count: number;
  recorded_at: Date;
  created_at: Date;
  is_expired: boolean;
  diary_expires_at: Date | null;
  reactions: Record<string, string[]>;
  is_pinned: boolean;
  caption: string | null;
  forwarded_from: string | null;
  saved_to_moments: boolean;
  saved_to_moments_at: Date | null;
}

export interface EntryWithUrl extends DiaryEntry {
  media_url: string | null;
  thumbnail_url: string | null;
}

export interface PageResult {
  entries: DiaryEntry[];
  next_cursor: string | null;
  has_more: boolean;
  total_count: number;
}

// Internal DB row (includes media_key for download URL generation)
interface DbEntry extends DiaryEntry {
  media_key: string | null;
  thumbnail_key: string | null;
}

// 24 hours — content visible in diary thread for this long, then tombstoned
const DIARY_EXPIRY_HOURS = 24;

interface RateLimitRow { count: string }

@Injectable()
export class EntriesService {
  private readonly logger = new Logger(EntriesService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly storage: StorageService,
    private readonly eventEmitter: EventEmitter2,
    private readonly config: ConfigService,
    private readonly streaksService: StreaksService,
    private readonly eventsService: EventsService,
  ) {}

  // ── Upload URL ─────────────────────────────────────────────────────────────

  async getUploadUrl(
    _userId: string,
    connectionId: string,
    dto: UploadUrlDto,
  ): Promise<UploadUrlResult> {
    // Rate limit: 30 uploads per connection per IST calendar day
    const istDate = toISTDate(new Date());
    const rlKey = `upload:${connectionId}:${istDate}`;
    await this.enforceRateLimit(rlKey, 86400, 30, 'UPLOAD_RATE_LIMIT');

    // Generate entry UUID upfront — Flutter sends this back in createEntry
    const entryId = randomUUID();

    const mediaKey =
      dto.entry_type === 'voice'
        ? StorageService.voiceKey(connectionId, entryId)
        : StorageService.videoKey(connectionId, entryId);

    const uploadUrl = await this.storage.getSignedUploadUrl(mediaKey);
    return { media_key: mediaKey, entry_id: entryId, upload_url: uploadUrl };
  }

  // ── Request Upload (Telegram-style step 1) ────────────────────────────────
  // Pre-creates a pending DB row and returns a presigned PUT URL.
  // Flutter uploads directly to B2, then calls confirmUpload.

  async requestUpload(
    userId: string,
    connectionId: string,
    dto: RequestUploadDto,
  ): Promise<RequestUploadResult> {
    await this.assertNotBlocked(userId, connectionId);
    const clientMsgId = dto.client_msg_id ?? null;

    // Idempotent retry: if this client_msg_id already has a row (from a prior
    // request-upload whose response was lost), reuse it — hand back the same
    // entry_id with a fresh presigned URL instead of creating a duplicate row
    // and burning another rate-limit slot.
    if (clientMsgId) {
      const existing = await this.db.query<{ id: string; media_key: string }[]>(
        `SELECT id, media_key FROM diary_entries
         WHERE connection_id = $1 AND client_msg_id = $2 AND deleted_at IS NULL`,
        [connectionId, clientMsgId],
      );
      if (existing.length) {
        const uploadUrl = await this.storage.getSignedUploadUrl(existing[0].media_key);
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        return {
          entry_id: existing[0].id,
          media_key: existing[0].media_key,
          upload_url: uploadUrl,
          expires_at: expiresAt,
        };
      }
    }

    // Rate limit: 30 uploads per connection per IST calendar day
    const istDate = toISTDate(new Date());
    const rlKey = `upload:${connectionId}:${istDate}`;
    await this.enforceRateLimit(rlKey, 86400, 30, 'UPLOAD_RATE_LIMIT');

    const entryId = randomUUID();
    const mediaKey =
      dto.entry_type === 'voice'
        ? StorageService.voiceKey(connectionId, entryId)
        : StorageService.videoKey(connectionId, entryId);

    // Pre-create the pending entry so the ID is stable end-to-end
    await this.db.query(
      `INSERT INTO diary_entries
         (id, connection_id, author_id, entry_type, media_key, upload_status, client_msg_id)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
      [entryId, connectionId, userId, dto.entry_type, mediaKey, clientMsgId],
    );

    const uploadUrl = await this.storage.getSignedUploadUrl(mediaKey);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Fast delivery: tell the partner a memory is on its way NOW — before the
    // media even starts uploading to object storage. Both devices reference
    // the same entry id; the later new_entry event upgrades the placeholder
    // in place with the playable URL. Delivery never waits on storage.
    this.pushToPartner(userId, connectionId, {
      type: 'entry_incoming',
      entry_id: entryId,
      author_id: userId,
      entry_type: dto.entry_type,
    }).catch(() => {});

    return { entry_id: entryId, media_key: mediaKey, upload_url: uploadUrl, expires_at: expiresAt };
  }

  // ── Confirm Upload (Telegram-style step 2) ────────────────────────────────
  // Verifies the file landed in B2, marks the row completed,
  // then pushes an SSE new_entry event with a signed URL to the partner.

  async confirmUpload(
    userId: string,
    connectionId: string,
    dto: ConfirmUploadDto,
  ): Promise<DiaryEntry> {
    // Fetch the pending row — must belong to this connection and this author
    const rows = await this.db.query<{
      id: string;
      author_id: string;
      media_key: string;
      thumbnail_key: string | null;
      upload_status: string;
      entry_type: string;
    }[]>(
      `SELECT id, author_id, media_key, thumbnail_key, upload_status, entry_type
       FROM diary_entries
       WHERE id = $1 AND connection_id = $2 AND deleted_at IS NULL`,
      [dto.entry_id, connectionId],
    );

    if (!rows.length) {
      throw new NotFoundException({
        error: 'ENTRY_NOT_FOUND',
        message: 'Pending entry not found.',
      });
    }

    const pending = rows[0];

    if (pending.author_id !== userId) {
      throw new ForbiddenException({
        error: 'NOT_ENTRY_AUTHOR',
        message: 'Only the author can confirm an upload.',
      });
    }

    if (pending.upload_status !== 'pending') {
      throw new BadRequestException({
        error: 'ALREADY_CONFIRMED',
        message: 'Entry has already been confirmed or failed.',
      });
    }

    // Verify file landed in B2 (eventual consistency — up to 3 retries)
    let exists = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      exists = await this.storage.objectExists(pending.media_key);
      if (exists) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 600));
    }

    if (!exists) {
      await this.db.query(
        `UPDATE diary_entries SET upload_status = 'failed', updated_at = NOW() WHERE id = $1`,
        [dto.entry_id],
      );
      throw new BadRequestException({
        error: 'MEDIA_NOT_UPLOADED',
        message: 'Media file not found in storage. Upload may have failed.',
      });
    }

    const recordedAt = dto.recorded_at ? new Date(dto.recorded_at) : new Date();

    const updated = returningRows<DbEntry>(await this.db.query(
      `UPDATE diary_entries
       SET upload_status    = 'completed',
           duration_seconds = $1,
           mood             = $2,
           recorded_at      = $3::timestamptz,
           diary_expires_at = $3::timestamptz + INTERVAL '${DIARY_EXPIRY_HOURS} hours',
           updated_at       = NOW()
       WHERE id = $4
       RETURNING id, connection_id, author_id, entry_type, content,
                 media_key, duration_seconds, file_size_bytes, thumbnail_key,
                 transcription, transcription_status, mood,
                 is_starred, starred_at, play_count, recorded_at, created_at,
                 diary_expires_at, saved_to_moments, saved_to_moments_at`,
      [dto.duration_seconds, dto.mood ?? null, recordedAt, dto.entry_id],
    ));

    const entry = updated[0];

    // Update connection counters
    await this.db.query(
      `UPDATE diary_connections
       SET last_entry_at = NOW(),
           total_entry_count = total_entry_count + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [connectionId],
    );

    // Streak update
    await this.streaksService.onNewEntry(connectionId, recordedAt).catch((err: unknown) => {
      this.logger.error('Streak update failed for entry', err);
    });

    // Invalidate Memory Tree cache
    await this.db
      .query(`DELETE FROM memory_tree_cache WHERE connection_id = $1`, [connectionId])
      .catch(() => {});

    // Push SSE new_entry to partner with a pre-generated signed URL
    const partnerRows = await this.db.query<{ user_a_id: string; user_b_id: string }[]>(
      `SELECT user_a_id, user_b_id FROM diary_connections WHERE id = $1`,
      [connectionId],
    );

    if (partnerRows.length) {
      const { user_a_id, user_b_id } = partnerRows[0];
      const partnerId = user_a_id === userId ? user_b_id : user_a_id;

      try {
        const mediaUrl = await this.storage.getSignedDownloadUrl(entry.media_key!, 3600);
        const thumbnailUrl =
          entry.entry_type === 'video' && entry.thumbnail_key
            ? await this.storage.getSignedDownloadUrl(entry.thumbnail_key, 3600).catch(() => null)
            : null;
        const urlExpiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

        this.eventsService.push(partnerId, connectionId, {
          type: 'new_entry',
          entry_id: entry.id,
          author_id: userId,
          entry_type: entry.entry_type,
          duration_seconds: entry.duration_seconds,
          media_url: mediaUrl,
          thumbnail_url: thumbnailUrl,
          url_expires_at: urlExpiresAt,
        });
      } catch (err: unknown) {
        // SSE push failure must never block the response
        this.logger.error('SSE new_entry push failed', err);
      }
    }

    // Emit events for async workers (transcription, push notification)
    this.eventEmitter.emit('entry.created', {
      entryId: entry.id,
      mediaKey: entry.media_key,
      connectionId,
      authorId: userId,
      entryType: entry.entry_type,
      durationSeconds: dto.duration_seconds ?? null,
    });

    await this.writeAuditLog(userId, 'entry.created', 'diary_entry', entry.id);

    return this.toPublic(entry);
  }

  // ── Create Entry ───────────────────────────────────────────────────────────

  async createEntry(
    userId: string,
    connectionId: string,
    dto: CreateEntryDto,
  ): Promise<DiaryEntry> {
    await this.assertNotBlocked(userId, connectionId);
    const isText = dto.entry_type === 'text';

    if (!isText) {
      // ── 1. Verify the upload completed in storage ───────────────────────────
      // Supabase Storage has eventual consistency — the object may not be
      // visible immediately after a signed-URL PUT. Retry up to 3 times with
      // 600 ms gaps before giving up.
      let exists = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        exists = await this.storage.objectExists(dto.media_key!);
        if (exists) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 600));
      }
      if (!exists) {
        throw new BadRequestException({
          error: 'MEDIA_NOT_UPLOADED',
          message:
            'Media file not found. Please upload the audio/video before creating the entry.',
        });
      }

      // Security: media_key must belong to this connection
      const keyConnectionId =
        StorageService.extractConnectionIdFromKey(dto.media_key!);
      if (keyConnectionId && keyConnectionId !== connectionId) {
        throw new BadRequestException({
          error: 'INVALID_MEDIA_KEY',
          message: 'Media key does not belong to this connection.',
        });
      }
    }

    // ── 2. Insert diary entry ─────────────────────────────────────────────────
    const recordedAt = dto.recorded_at ? new Date(dto.recorded_at) : new Date();
    const clientMsgId = dto.client_msg_id ?? null;

    // ON CONFLICT DO NOTHING makes the insert idempotent when the client sends a
    // client_msg_id and retries a send whose response was lost — the second call
    // inserts nothing and we return the already-stored entry (below), rather than
    // creating a duplicate. The WHERE predicate matches the partial unique index.
    const rows = isText
      ? await this.db.query<DbEntry[]>(
          // Text messages: no media, no expiry, content stored inline
          `INSERT INTO diary_entries
             (connection_id, author_id, entry_type, content, mood, recorded_at, client_msg_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (connection_id, client_msg_id) WHERE client_msg_id IS NOT NULL DO NOTHING
           RETURNING id, connection_id, author_id, entry_type, content,
                     media_key, duration_seconds, file_size_bytes, thumbnail_key,
                     transcription, transcription_status, mood,
                     is_starred, starred_at, play_count, recorded_at, created_at,
                     diary_expires_at, saved_to_moments, saved_to_moments_at`,
          [connectionId, userId, dto.entry_type, dto.content, dto.mood ?? null, recordedAt, clientMsgId],
        )
      : await this.db.query<DbEntry[]>(
          `INSERT INTO diary_entries
             (connection_id, author_id, entry_type, media_key,
              duration_seconds, mood, recorded_at, diary_expires_at, client_msg_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz + INTERVAL '${DIARY_EXPIRY_HOURS} hours', $8)
           ON CONFLICT (connection_id, client_msg_id) WHERE client_msg_id IS NOT NULL DO NOTHING
           RETURNING id, connection_id, author_id, entry_type, content,
                     media_key, duration_seconds, file_size_bytes, thumbnail_key,
                     transcription, transcription_status, mood,
                     is_starred, starred_at, play_count, recorded_at, created_at,
                     diary_expires_at, saved_to_moments, saved_to_moments_at`,
          [connectionId, userId, dto.entry_type, dto.media_key, dto.duration_seconds, dto.mood ?? null, recordedAt, clientMsgId],
        );

    // Idempotent hit: the row already exists from a prior (successful) send, so
    // this is a retry. Return the stored entry and skip the counter/streak/SSE
    // side-effects — they already ran the first time.
    if (!rows.length) {
      const existing = await this.db.query<DbEntry[]>(
        `SELECT id, connection_id, author_id, entry_type, content,
                media_key, duration_seconds, file_size_bytes, thumbnail_key,
                transcription, transcription_status, mood,
                is_starred, starred_at, play_count, recorded_at, created_at,
                diary_expires_at, saved_to_moments, saved_to_moments_at
         FROM diary_entries
         WHERE connection_id = $1 AND client_msg_id = $2 AND deleted_at IS NULL`,
        [connectionId, clientMsgId],
      );
      if (existing.length) return this.toPublic(existing[0]);
      // Extremely unlikely (conflict with a soft-deleted row) — fail loud.
      throw new BadRequestException({
        error: 'DUPLICATE_MESSAGE',
        message: 'This message was already sent.',
      });
    }

    const entry = rows[0];

    // ── 3. Update connection counters ─────────────────────────────────────────
    await this.db.query(
      `UPDATE diary_connections
       SET last_entry_at = NOW(),
           total_entry_count = total_entry_count + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [connectionId],
    );

    // ── 4. Update streak via StreaksService ───────────────────────────────────
    await this.streaksService.onNewEntry(connectionId, recordedAt).catch((err: unknown) => {
      // Streak failure must never block entry creation
      this.logger.error('Streak update failed for entry', err);
    });

    // ── 5. Invalidate Memory Tree cache ───────────────────────────────────────
    await this.db
      .query(
        `DELETE FROM memory_tree_cache WHERE connection_id = $1`,
        [connectionId],
      )
      .catch(() => {}); // Cache miss is fine

    // ── 6. Emit events for async workers ─────────────────────────────────────
    // TranscriptionWorker and NotificationWorker listen for this event (Prompt 09).
    this.eventEmitter.emit('entry.created', {
      entryId: entry.id,
      mediaKey: dto.media_key,
      connectionId,
      authorId: userId,
      entryType: dto.entry_type,
      durationSeconds: dto.duration_seconds ?? null,
    });

    // ── 7. Audit log ──────────────────────────────────────────────────────────
    await this.writeAuditLog(userId, 'entry.created', 'diary_entry', entry.id);

    return this.toPublic(entry);
  }

  // ── List Entries ───────────────────────────────────────────────────────────

  async listEntries(
    userId: string,
    connectionId: string,
    dto: ListEntriesDto,
  ): Promise<PageResult> {
    const limit = dto.limit ?? 20;
    const filter = dto.filter ?? 'all';

    // Build query dynamically. hidden_for = delete-for-me: those entries are
    // invisible to this user only.
    const params: unknown[] = [connectionId, userId];
    let where = `WHERE connection_id = $1 AND deleted_at IS NULL AND upload_status = 'completed'
      AND NOT ($2 = ANY(hidden_for))`;

    // Type filter (safe to embed — validated by DTO)
    if (filter === 'voice') where += ` AND entry_type = 'voice'`;
    if (filter === 'video') where += ` AND entry_type = 'video'`;
    if (filter === 'starred') where += ` AND is_starred = true`;

    // Cursor pagination
    if (dto.cursor) {
      const decoded = decodeCursor(dto.cursor);
      if (decoded) {
        const p1 = params.length + 1;
        const p2 = params.length + 2;
        where += ` AND (recorded_at < $${p1} OR (recorded_at = $${p1} AND id < $${p2}))`;
        params.push(decoded.recordedAt, decoded.id);
      }
    }

    // Fetch limit+1 to detect if there's a next page
    params.push(limit + 1);
    const pLimit = params.length;

    const rows = await this.db.query<DbEntry[]>(
      `SELECT id, connection_id, author_id, entry_type, content,
              duration_seconds, file_size_bytes, transcription,
              transcription_status, mood, is_starred, starred_at,
              play_count, recorded_at, created_at,
              media_key, thumbnail_key, diary_expires_at,
              saved_to_moments, saved_to_moments_at,
              reactions, is_pinned, caption, forwarded_from
       FROM diary_entries
       ${where}
       ORDER BY recorded_at DESC, id DESC
       LIMIT $${pLimit}`,
      params,
    );

    const has_more = rows.length > limit;
    const entries = has_more ? rows.slice(0, limit) : rows;
    const last = entries[entries.length - 1];

    const next_cursor =
      has_more && last
        ? encodeCursor(new Date(last.recorded_at), last.id)
        : null;

    // Total count from connection row (cheap — denormalized)
    const countRows = await this.db.query<{ total_entry_count: string }[]>(
      `SELECT total_entry_count FROM diary_connections WHERE id = $1`,
      [connectionId],
    );
    const total_count = parseInt(countRows[0]?.total_entry_count ?? '0', 10);

    return {
      entries: entries.map((e) => this.toPublic(e)),
      next_cursor,
      has_more,
      total_count,
    };
  }

  // ── Get Single Entry ───────────────────────────────────────────────────────

  async getEntry(
    _userId: string,
    connectionId: string,
    entryId: string,
  ): Promise<EntryWithUrl> {
    return this._fetchEntryWithUrl(connectionId, entryId, false);
  }

  // Used by the Memory Tree — bypasses the 24-hour diary expiry so old moments
  // remain fully playable even after they've vanished from the diary thread.
  async getEntryForMoments(
    _userId: string,
    connectionId: string,
    entryId: string,
  ): Promise<EntryWithUrl> {
    return this._fetchEntryWithUrl(connectionId, entryId, true);
  }

  private async _fetchEntryWithUrl(
    connectionId: string,
    entryId: string,
    bypassExpiry: boolean,
  ): Promise<EntryWithUrl> {
    const rows = await this.db.query<DbEntry[]>(
      `SELECT id, connection_id, author_id, entry_type, content,
              media_key, thumbnail_key, duration_seconds, file_size_bytes,
              transcription, transcription_status, mood,
              is_starred, starred_at, play_count, recorded_at, created_at,
              diary_expires_at, saved_to_moments, saved_to_moments_at
       FROM diary_entries
       WHERE id = $1
         AND connection_id = $2
         AND deleted_at IS NULL`,
      [entryId, connectionId],
    );

    if (!rows.length) {
      throw new NotFoundException({
        error: 'ENTRY_NOT_FOUND',
        message: 'Diary entry not found.',
      });
    }

    const entry = rows[0];
    const isExpired = this._isExpired(entry.diary_expires_at);

    // Text entries have no media — always return null URLs.
    if (entry.entry_type === 'text') {
      return { ...this.toPublic(entry), media_url: null, thumbnail_url: null };
    }

    // Diary thread: expired entries return tombstone (no media URL).
    // Memory Tree (bypassExpiry): always return the signed URL.
    if (isExpired && !bypassExpiry) {
      return {
        ...this.toPublic(entry),
        media_url: null,
        thumbnail_url: null,
      };
    }

    const mediaUrl = await this.storage.getSignedDownloadUrl(entry.media_key!, 3600);
    const thumbnailUrl =
      entry.entry_type === 'video' && entry.thumbnail_key
        ? await this.storage.getSignedDownloadUrl(entry.thumbnail_key, 3600).catch(() => null)
        : null;

    return {
      ...this.toPublic(entry),
      media_url: mediaUrl,
      thumbnail_url: thumbnailUrl,
    };
  }

  private _isExpired(expiresAt: Date | null): boolean {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
  }

  // ── Star / Unstar ──────────────────────────────────────────────────────────

  async starEntry(
    _userId: string,
    connectionId: string,
    entryId: string,
    isStarred: boolean,
  ): Promise<DiaryEntry> {
    const rows = returningRows<DbEntry>(await this.db.query(
      `UPDATE diary_entries
       SET is_starred = $1,
           starred_at = CASE WHEN $1 = true THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE id = $2
         AND connection_id = $3
         AND deleted_at IS NULL
       RETURNING id, connection_id, author_id, entry_type, content,
                 media_key, thumbnail_key, duration_seconds, file_size_bytes,
                 transcription, transcription_status, mood,
                 is_starred, starred_at, play_count, recorded_at, created_at,
                 diary_expires_at, saved_to_moments, saved_to_moments_at`,
      [isStarred, entryId, connectionId],
    ));

    if (!rows.length) {
      throw new NotFoundException({
        error: 'ENTRY_NOT_FOUND',
        message: 'Diary entry not found.',
      });
    }

    return this.toPublic(rows[0]);
  }

  // ── Messaging actions ──────────────────────────────────────────────────────

  /** One reaction per user: reacting replaces any previous emoji; sending the
   *  same emoji again removes it. Pushes reaction_updated to the partner. */
  async toggleReaction(
    userId: string,
    connectionId: string,
    entryId: string,
    emoji: string,
  ): Promise<Record<string, string[]>> {
    const rows = await this.db.query<{ reactions: Record<string, string[]> }[]>(
      `SELECT reactions FROM diary_entries
       WHERE id = $1 AND connection_id = $2 AND deleted_at IS NULL`,
      [entryId, connectionId],
    );
    if (!rows.length) {
      throw new NotFoundException({ error: 'ENTRY_NOT_FOUND', message: 'Diary entry not found.' });
    }

    const reactions: Record<string, string[]> = rows[0].reactions ?? {};
    const hadSame = (reactions[emoji] ?? []).includes(userId);
    // Remove the user's existing reaction (any emoji), then re-add unless toggling off.
    for (const key of Object.keys(reactions)) {
      reactions[key] = reactions[key].filter((u) => u !== userId);
      if (!reactions[key].length) delete reactions[key];
    }
    if (!hadSame) reactions[emoji] = [...(reactions[emoji] ?? []), userId];

    await this.db.query(
      `UPDATE diary_entries SET reactions = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(reactions), entryId],
    );

    await this.pushToPartner(userId, connectionId, {
      type: 'reaction_updated',
      entry_id: entryId,
      reactions,
    });
    return reactions;
  }

  /** Shared pin — either member can pin/unpin an entry in the thread. */
  async setPinned(
    userId: string,
    connectionId: string,
    entryId: string,
    isPinned: boolean,
  ): Promise<void> {
    const rows = returningRows(
      await this.db.query(
        `UPDATE diary_entries
         SET is_pinned = $1, pinned_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
             updated_at = NOW()
         WHERE id = $2 AND connection_id = $3 AND deleted_at IS NULL
         RETURNING id`,
        [isPinned, entryId, connectionId],
      ),
    );
    if (!rows.length) {
      throw new NotFoundException({ error: 'ENTRY_NOT_FOUND', message: 'Diary entry not found.' });
    }
    await this.pushToPartner(userId, connectionId, {
      type: 'entry_pinned',
      entry_id: entryId,
      is_pinned: isPinned,
    });
  }

  /** Caption text on a captured memory — author-only. The media itself is
   *  immutable; only this text annotation can ever be added or edited. */
  async setCaption(
    userId: string,
    connectionId: string,
    entryId: string,
    caption: string | null,
  ): Promise<void> {
    const rows = returningRows(
      await this.db.query(
        `UPDATE diary_entries
         SET caption = $1, updated_at = NOW()
         WHERE id = $2 AND connection_id = $3 AND author_id = $4 AND deleted_at IS NULL
         RETURNING id`,
        [caption, entryId, connectionId, userId],
      ),
    );
    if (!rows.length) {
      throw new NotFoundException({
        error: 'ENTRY_NOT_FOUND',
        message: 'Entry not found, or you are not its author.',
      });
    }
    await this.pushToPartner(userId, connectionId, {
      type: 'caption_updated',
      entry_id: entryId,
      caption,
    });
  }

  /** Delete-for-me: hides the entry from this user only. */
  async hideForMe(
    userId: string,
    connectionId: string,
    entryId: string,
  ): Promise<void> {
    const rows = returningRows(
      await this.db.query(
        `UPDATE diary_entries
         SET hidden_for = array_append(hidden_for, $1), updated_at = NOW()
         WHERE id = $2 AND connection_id = $3 AND deleted_at IS NULL
           AND NOT ($1 = ANY(hidden_for))
         RETURNING id`,
        [userId, entryId, connectionId],
      ),
    );
    if (!rows.length) {
      throw new NotFoundException({
        error: 'ENTRY_NOT_FOUND',
        message: 'Entry not found or already hidden.',
      });
    }
  }

  /** Forwards a memory to another of the user's diaries. The captured media is
   *  shared by key — never re-encoded, never editable. */
  async forwardEntry(
    userId: string,
    connectionId: string,
    entryId: string,
    toConnectionId: string,
  ): Promise<PublicEntry> {
    // Source entry must be visible to the forwarder.
    const src = await this.db.query<DbEntry[]>(
      `SELECT * FROM diary_entries
       WHERE id = $1 AND connection_id = $2 AND deleted_at IS NULL
         AND NOT ($3 = ANY(hidden_for))`,
      [entryId, connectionId, userId],
    ).then((r) => (r.length ? r : Promise.reject(
      new NotFoundException({ error: 'ENTRY_NOT_FOUND', message: 'Diary entry not found.' }))));

    // Target: user must be a member of an active connection, and not blocked.
    const target = await this.db.query<{ id: string }[]>(
      `SELECT id FROM diary_connections
       WHERE id = $1 AND status = 'active'
         AND (user_a_id = $2 OR user_b_id = $2)`,
      [toConnectionId, userId],
    );
    if (!target.length) {
      throw new ForbiddenException({
        error: 'NOT_CONNECTION_MEMBER',
        message: 'You are not a member of the target diary.',
      });
    }
    await this.assertNotBlocked(userId, toConnectionId);

    const e = src[0];
    const inserted = await this.db.query<DbEntry[]>(
      `INSERT INTO diary_entries
         (connection_id, author_id, entry_type, content, media_key, thumbnail_key,
          duration_seconds, file_size_bytes, caption, forwarded_from,
          upload_status, recorded_at, diary_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               'completed', NOW(), NOW() + interval '24 hours')
       RETURNING *`,
      [
        toConnectionId, userId, e.entry_type, e.content, e.media_key,
        e.thumbnail_key, e.duration_seconds, e.file_size_bytes, e.caption, e.id,
      ],
    );
    const fwd = inserted[0];

    // Notify the target partner exactly like a fresh entry.
    try {
      const mediaUrl = fwd.media_key
        ? await this.storage.getSignedDownloadUrl(fwd.media_key, 3600)
        : null;
      await this.pushToPartner(userId, toConnectionId, {
        type: 'new_entry',
        entry_id: fwd.id,
        author_id: userId,
        entry_type: fwd.entry_type,
        duration_seconds: fwd.duration_seconds,
        media_url: mediaUrl,
        forwarded: true,
      });
    } catch (err: unknown) {
      this.logger.error('SSE forward push failed', err);
    }
    await this.writeAuditLog(userId, 'entry.forwarded', 'diary_entry', fwd.id);
    return this.toPublic(fwd);
  }

  /** 403 USER_BLOCKED if either side of the connection has blocked the other. */
  async assertNotBlocked(_userId: string, connectionId: string): Promise<void> {
    const rows = await this.db.query<{ n: string }[]>(
      `SELECT COUNT(*) AS n
       FROM user_blocks b
       JOIN diary_connections c ON c.id = $1
       WHERE (b.blocker_id = c.user_a_id AND b.blocked_id = c.user_b_id)
          OR (b.blocker_id = c.user_b_id AND b.blocked_id = c.user_a_id)`,
      [connectionId],
    );
    if (Number(rows[0]?.n ?? 0) > 0) {
      throw new ForbiddenException({
        error: 'USER_BLOCKED',
        message: 'Memories cannot be exchanged in this diary.',
      });
    }
  }

  private async pushToPartner(
    userId: string,
    connectionId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const rows = await this.db.query<{ user_a_id: string; user_b_id: string }[]>(
      `SELECT user_a_id, user_b_id FROM diary_connections WHERE id = $1`,
      [connectionId],
    );
    if (!rows.length) return;
    const { user_a_id, user_b_id } = rows[0];
    const partnerId = user_a_id === userId ? user_b_id : user_a_id;
    try {
      this.eventsService.push(partnerId, connectionId, payload as never);
    } catch (err: unknown) {
      this.logger.error('SSE push failed', err);
    }
  }

  // ── Soft Delete ────────────────────────────────────────────────────────────

  async softDeleteEntry(
    userId: string,
    connectionId: string,
    entryId: string,
  ): Promise<void> {
    // Verify ownership: only the author can delete
    const ownerRows = await this.db.query<{ author_id: string; recorded_at: Date }[]>(
      `SELECT author_id, recorded_at
       FROM diary_entries
       WHERE id = $1 AND connection_id = $2 AND deleted_at IS NULL`,
      [entryId, connectionId],
    );

    if (!ownerRows.length) {
      throw new NotFoundException({
        error: 'ENTRY_NOT_FOUND',
        message: 'Diary entry not found.',
      });
    }

    if (ownerRows[0].author_id !== userId) {
      throw new ForbiddenException({
        error: 'NOT_ENTRY_AUTHOR',
        message: 'Only the author of an entry can delete it.',
      });
    }

    // Delete-for-everyone is only allowed within a window of sending; after
    // that the memory belongs to both people (use delete-for-me instead).
    const windowMin = Number(process.env.DELETE_FOR_EVERYONE_WINDOW_MIN ?? 60);
    const ageMs = Date.now() - new Date(ownerRows[0].recorded_at).getTime();
    if (ageMs > windowMin * 60 * 1000) {
      throw new ForbiddenException({
        error: 'DELETE_WINDOW_EXPIRED',
        message: `Memories can only be deleted for everyone within ${windowMin} minutes of sending.`,
      });
    }

    // Soft delete — never hard delete emotional data
    await this.db.query(
      `UPDATE diary_entries
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [entryId],
    );

    await this.pushToPartner(userId, connectionId, {
      type: 'entry_deleted',
      entry_id: entryId,
    });

    // Audit log
    await this.writeAuditLog(userId, 'entry.deleted', 'diary_entry', entryId);

    // Update connection's last_entry_at to the new latest (runs regardless of whether
    // this was the latest entry — cheap and idempotent)
    await this.db.query(
      `UPDATE diary_connections
       SET last_entry_at = (
             SELECT MAX(recorded_at)
             FROM diary_entries
             WHERE connection_id = $1 AND deleted_at IS NULL
           ),
           total_entry_count = GREATEST(0, total_entry_count - 1),
           updated_at = NOW()
       WHERE id = $1`,
      [connectionId],
    );

    // Invalidate Memory Tree cache
    await this.db
      .query(
        `DELETE FROM memory_tree_cache WHERE connection_id = $1`,
        [connectionId],
      )
      .catch(() => {});
  }

  // ── Record Play ────────────────────────────────────────────────────────────

  async recordPlay(
    _userId: string,
    connectionId: string,
    entryId: string,
  ): Promise<{ play_count: number }> {
    const rows = returningRows<{ play_count: number }>(await this.db.query(
      `UPDATE diary_entries
       SET play_count = play_count + 1, updated_at = NOW()
       WHERE id = $1
         AND connection_id = $2
         AND deleted_at IS NULL
       RETURNING play_count`,
      [entryId, connectionId],
    ));

    if (!rows.length) {
      throw new NotFoundException({
        error: 'ENTRY_NOT_FOUND',
        message: 'Diary entry not found.',
      });
    }

    return { play_count: Number(rows[0].play_count) };
  }

  // ── Save to Moments ────────────────────────────────────────────────────────

  async saveToMoments(
    _userId: string,
    connectionId: string,
    entryId: string,
  ): Promise<DiaryEntry> {
    const rows = returningRows<DbEntry>(await this.db.query(
      `UPDATE diary_entries
       SET saved_to_moments    = true,
           saved_to_moments_at = NOW(),
           updated_at          = NOW()
       WHERE id             = $1
         AND connection_id  = $2
         AND entry_type     = 'text'
         AND deleted_at     IS NULL
       RETURNING id, connection_id, author_id, entry_type, content,
                 media_key, thumbnail_key, duration_seconds, file_size_bytes,
                 transcription, transcription_status, mood,
                 is_starred, starred_at, play_count, recorded_at, created_at,
                 diary_expires_at, saved_to_moments, saved_to_moments_at`,
      [entryId, connectionId],
    ));

    if (!rows.length) {
      throw new NotFoundException({
        error: 'ENTRY_NOT_FOUND',
        message: 'Text entry not found.',
      });
    }

    return this.toPublic(rows[0]);
  }

  async removeFromMoments(
    _userId: string,
    connectionId: string,
    entryId: string,
  ): Promise<DiaryEntry> {
    const rows = returningRows<DbEntry>(await this.db.query(
      `UPDATE diary_entries
       SET saved_to_moments    = false,
           saved_to_moments_at = NULL,
           updated_at          = NOW()
       WHERE id             = $1
         AND connection_id  = $2
         AND entry_type     = 'text'
         AND deleted_at     IS NULL
       RETURNING id, connection_id, author_id, entry_type, content,
                 media_key, thumbnail_key, duration_seconds, file_size_bytes,
                 transcription, transcription_status, mood,
                 is_starred, starred_at, play_count, recorded_at, created_at,
                 diary_expires_at, saved_to_moments, saved_to_moments_at`,
      [entryId, connectionId],
    ));

    if (!rows.length) {
      throw new NotFoundException({
        error: 'ENTRY_NOT_FOUND',
        message: 'Text entry not found.',
      });
    }

    return this.toPublic(rows[0]);
  }

  // ── Rate limiting ──────────────────────────────────────────────────────────

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
        message: 'Upload rate limit exceeded. Try again tomorrow.',
      });
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private toPublic(entry: DbEntry): DiaryEntry {
    // Never expose media_key or thumbnail_key in list responses.
    // Signed URLs are generated only in getEntry / getEntryForMoments.
    return {
      id: entry.id,
      connection_id: entry.connection_id,
      author_id: entry.author_id,
      entry_type: entry.entry_type,
      content: entry.content ?? null,
      duration_seconds: entry.duration_seconds,
      file_size_bytes: entry.file_size_bytes,
      transcription: entry.transcription,
      transcription_status: entry.transcription_status,
      mood: entry.mood,
      is_starred: entry.is_starred,
      starred_at: entry.starred_at,
      play_count: Number(entry.play_count),
      recorded_at: entry.recorded_at,
      created_at: entry.created_at,
      is_expired: this._isExpired(entry.diary_expires_at),
      diary_expires_at: entry.diary_expires_at,
      saved_to_moments: entry.saved_to_moments ?? false,
      saved_to_moments_at: entry.saved_to_moments_at ?? null,
      reactions: entry.reactions ?? {},
      is_pinned: entry.is_pinned ?? false,
      caption: entry.caption ?? null,
      forwarded_from: entry.forwarded_from ?? null,
    };
  }

  private async writeAuditLog(
    userId: string,
    action: string,
    resourceType: string,
    resourceId: string,
  ): Promise<void> {
    await this.db
      .query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, action, resourceType, resourceId],
      )
      .catch((err: unknown) => this.logger.error('Audit log write failed', err));
  }
}

// toISTDate, computeWeather and streak logic moved to StreaksService (Prompt 13)
