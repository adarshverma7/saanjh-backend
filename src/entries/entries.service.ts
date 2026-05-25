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
import { StreaksService, toISTDate } from '../streaks/streaks.service';
import {
  encodeCursor,
  decodeCursor,
} from '../shared/helpers/pagination.helper';
import type { UploadUrlDto } from './dto/upload-url.dto';
import type { CreateEntryDto } from './dto/create-entry.dto';
import type { ListEntriesDto } from './dto/list-entries.dto';

// ── Public types ─────────────────────────────────────────────────────────────

export interface UploadUrlResult {
  media_key: string;
  entry_id: string;
  upload_url: string;
}

export interface DiaryEntry {
  id: string;
  connection_id: string;
  author_id: string;
  entry_type: string;
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
  media_key: string;
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

  // ── Create Entry ───────────────────────────────────────────────────────────

  async createEntry(
    userId: string,
    connectionId: string,
    dto: CreateEntryDto,
  ): Promise<DiaryEntry> {
    // ── 1. Verify the upload completed in storage ─────────────────────────────
    // Supabase Storage has eventual consistency — the object may not be
    // visible immediately after a signed-URL PUT. Retry up to 3 times with
    // 600 ms gaps before giving up.
    let exists = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      exists = await this.storage.objectExists(dto.media_key);
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
      StorageService.extractConnectionIdFromKey(dto.media_key);
    if (keyConnectionId && keyConnectionId !== connectionId) {
      throw new BadRequestException({
        error: 'INVALID_MEDIA_KEY',
        message: 'Media key does not belong to this connection.',
      });
    }

    // ── 2. Insert diary entry ─────────────────────────────────────────────────
    const recordedAt = dto.recorded_at ? new Date(dto.recorded_at) : new Date();

    const rows = await this.db.query<DbEntry[]>(
      `INSERT INTO diary_entries
         (connection_id, author_id, entry_type, media_key,
          duration_seconds, mood, recorded_at, diary_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7 + INTERVAL '${DIARY_EXPIRY_HOURS} hours')
       RETURNING id, connection_id, author_id, entry_type, media_key,
                 duration_seconds, file_size_bytes, thumbnail_key,
                 transcription, transcription_status, mood,
                 is_starred, starred_at, play_count, recorded_at, created_at,
                 diary_expires_at`,
      [
        connectionId,
        userId,
        dto.entry_type,
        dto.media_key,
        dto.duration_seconds,
        dto.mood ?? null,
        recordedAt,
      ],
    );

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
    });

    // ── 7. Audit log ──────────────────────────────────────────────────────────
    await this.writeAuditLog(userId, 'entry.created', 'diary_entry', entry.id);

    return this.toPublic(entry);
  }

  // ── List Entries ───────────────────────────────────────────────────────────

  async listEntries(
    _userId: string,
    connectionId: string,
    dto: ListEntriesDto,
  ): Promise<PageResult> {
    const limit = dto.limit ?? 20;
    const filter = dto.filter ?? 'all';

    // Build query dynamically
    const params: unknown[] = [connectionId];
    let where = `WHERE connection_id = $1 AND deleted_at IS NULL`;

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
      `SELECT id, connection_id, author_id, entry_type,
              duration_seconds, file_size_bytes, transcription,
              transcription_status, mood, is_starred, starred_at,
              play_count, recorded_at, created_at,
              media_key, thumbnail_key, diary_expires_at
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
      `SELECT id, connection_id, author_id, entry_type, media_key,
              thumbnail_key, duration_seconds, file_size_bytes,
              transcription, transcription_status, mood,
              is_starred, starred_at, play_count, recorded_at, created_at,
              diary_expires_at
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

    // Diary thread: expired entries return tombstone (no media URL).
    // Memory Tree (bypassExpiry): always return the signed URL.
    if (isExpired && !bypassExpiry) {
      return {
        ...this.toPublic(entry),
        media_url: null,
        thumbnail_url: null,
      };
    }

    const mediaUrl = await this.storage.getSignedDownloadUrl(entry.media_key, 3600);
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
    const rows = await this.db.query<DbEntry[]>(
      `UPDATE diary_entries
       SET is_starred = $1,
           starred_at = CASE WHEN $1 = true THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE id = $2
         AND connection_id = $3
         AND deleted_at IS NULL
       RETURNING id, connection_id, author_id, entry_type, media_key,
                 thumbnail_key, duration_seconds, file_size_bytes,
                 transcription, transcription_status, mood,
                 is_starred, starred_at, play_count, recorded_at, created_at`,
      [isStarred, entryId, connectionId],
    );

    if (!rows.length) {
      throw new NotFoundException({
        error: 'ENTRY_NOT_FOUND',
        message: 'Diary entry not found.',
      });
    }

    return this.toPublic(rows[0]);
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

    // Soft delete — never hard delete emotional data
    await this.db.query(
      `UPDATE diary_entries
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [entryId],
    );

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
    const rows = await this.db.query<{ play_count: number }[]>(
      `UPDATE diary_entries
       SET play_count = play_count + 1, updated_at = NOW()
       WHERE id = $1
         AND connection_id = $2
         AND deleted_at IS NULL
       RETURNING play_count`,
      [entryId, connectionId],
    );

    if (!rows.length) {
      throw new NotFoundException({
        error: 'ENTRY_NOT_FOUND',
        message: 'Diary entry not found.',
      });
    }

    return { play_count: Number(rows[0].play_count) };
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
