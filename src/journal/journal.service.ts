import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { StorageService } from '../shared/storage/storage.service';
import { returningRows } from '../shared/database/query-utils';
import {
  encodeCursor,
  decodeCursor,
} from '../shared/helpers/pagination.helper';
import type { JournalUploadUrlDto } from './dto/journal-upload-url.dto';
import type { CreateJournalEntryDto } from './dto/create-journal-entry.dto';
import type { ListJournalDto } from './dto/list-journal.dto';
import type { JournalConfirmUploadDto } from './dto/journal-confirm-upload.dto';

// ── Public interfaces ────────────────────────────────────────────────────────

export interface JournalEntry {
  id: string;
  user_id: string;
  entry_type: string;
  text_content: string | null;
  duration_seconds: number | null;
  mood: string | null;
  is_starred: boolean;
  recorded_at: Date;
  created_at: Date;
}

export interface JournalEntryWithUrl extends JournalEntry {
  media_url: string | null;
}

export interface JournalPageResult {
  entries: JournalEntry[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface UploadUrlResult {
  upload_url: string;
  media_key: string;
  expires_in: number;
}

export interface JournalRequestUploadResult {
  entry_id: string;
  media_key: string;
  upload_url: string;
  expires_at: string;
}

// ── Internal DB row ──────────────────────────────────────────────────────────

interface DbEntry extends JournalEntry {
  media_key: string | null;
  deleted_at: Date | null;
}

// ── JournalService ────────────────────────────────────────────────────────────

/**
 * SECURITY INVARIANT: Every DB query in this service MUST include
 * `WHERE ... AND user_id = $userId`. This is the ONLY access control —
 * there is no ConnectionMemberGuard. No admin can read journal content.
 */
@Injectable()
export class JournalService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly storage: StorageService,
  ) {}

  // ── Upload URL ─────────────────────────────────────────────────────────────

  /**
   * Returns a pre-signed R2 PUT URL for direct upload from Flutter.
   * No 20-second duration limit — personal journal allows up to 5 minutes.
   * The media key is scoped to this user's journal prefix.
   */
  async getUploadUrl(
    userId: string,
    dto: JournalUploadUrlDto,
  ): Promise<UploadUrlResult> {
    const entryId = randomUUID();
    const mediaKey =
      dto.entry_type === 'video'
        ? StorageService.journalKey(userId, entryId).replace('.m4a', '.mp4')
        : StorageService.journalKey(userId, entryId);

    const uploadUrl = await this.storage.getSignedUploadUrl(mediaKey);

    return { upload_url: uploadUrl, media_key: mediaKey, expires_in: 900 };
  }

  // ── Request Upload (Telegram-style step 1) ────────────────────────────────

  async requestUpload(
    userId: string,
    entry_type: 'voice' | 'video',
  ): Promise<JournalRequestUploadResult> {
    const entryId = randomUUID();
    const mediaKey =
      entry_type === 'video'
        ? StorageService.journalKey(userId, entryId).replace('.m4a', '.mp4')
        : StorageService.journalKey(userId, entryId);

    // Pre-create pending row — upload_status defaults to 'pending' in the INSERT
    await this.db.query(
      `INSERT INTO personal_journal_entries
         (id, user_id, entry_type, media_key, upload_status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [entryId, userId, entry_type, mediaKey],
    );

    const uploadUrl = await this.storage.getSignedUploadUrl(mediaKey);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    return { entry_id: entryId, media_key: mediaKey, upload_url: uploadUrl, expires_at: expiresAt };
  }

  // ── Confirm Upload (Telegram-style step 2) ────────────────────────────────

  async confirmUpload(
    userId: string,
    dto: JournalConfirmUploadDto,
  ): Promise<JournalEntry> {
    // SECURITY: user_id = $2 ensures only the owner can confirm
    const rows = await this.db.query<{
      id: string;
      user_id: string;
      media_key: string;
      upload_status: string;
    }[]>(
      `SELECT id, user_id, media_key, upload_status
       FROM personal_journal_entries
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [dto.entry_id, userId],
    );

    if (!rows.length) {
      throw new NotFoundException({
        error: 'JOURNAL_ENTRY_NOT_FOUND',
        message: 'Pending journal entry not found.',
      });
    }

    const pending = rows[0];

    if (pending.upload_status !== 'pending') {
      throw new BadRequestException({
        error: 'ALREADY_CONFIRMED',
        message: 'Entry has already been confirmed or failed.',
      });
    }

    const exists = await this.storage.objectExists(pending.media_key);
    if (!exists) {
      await this.db.query(
        `UPDATE personal_journal_entries SET upload_status = 'failed' WHERE id = $1`,
        [dto.entry_id],
      );
      throw new BadRequestException({
        error: 'MEDIA_NOT_UPLOADED',
        message: 'Media file not found in storage. Upload may have failed.',
      });
    }

    const recordedAt = dto.recorded_at ? new Date(dto.recorded_at) : new Date();

    const updated = returningRows<DbEntry>(await this.db.query(
      `UPDATE personal_journal_entries
       SET upload_status    = 'completed',
           duration_seconds = $1,
           mood             = $2,
           recorded_at      = $3
       WHERE id = $4
       RETURNING id, user_id, entry_type, text_content, duration_seconds,
                 mood, is_starred, recorded_at, created_at`,
      [dto.duration_seconds ?? null, dto.mood ?? null, recordedAt, dto.entry_id],
    ));

    return this.toPublic(updated[0]);
  }

  // ── Create Entry ───────────────────────────────────────────────────────────

  async createEntry(
    userId: string,
    dto: CreateJournalEntryDto,
  ): Promise<JournalEntry> {
    // Media validation (voice/video entries)
    if (dto.media_key) {
      // SECURITY: media_key must belong to this user's journal namespace
      if (!dto.media_key.startsWith(`entries/journal/${userId}/`)) {
        throw new BadRequestException({
          error: 'INVALID_MEDIA_KEY',
          message: 'Media key does not belong to your journal.',
        });
      }

      const exists = await this.storage.objectExists(dto.media_key);
      if (!exists) {
        throw new BadRequestException({
          error: 'MEDIA_NOT_UPLOADED',
          message: 'Media file not found. Please upload before creating the entry.',
        });
      }
    }

    // Text entries must have text_content
    if (dto.entry_type === 'text' && !dto.text_content?.trim()) {
      throw new BadRequestException({
        error: 'TEXT_REQUIRED',
        message: 'text_content is required for text entries.',
      });
    }

    const rows = await this.db.query<DbEntry[]>(
      `INSERT INTO personal_journal_entries
         (user_id, entry_type, media_key, text_content, duration_seconds, mood)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, entry_type, text_content, duration_seconds,
                 mood, is_starred, recorded_at, created_at`,
      [
        userId,
        dto.entry_type,
        dto.media_key ?? null,
        dto.text_content ?? null,
        dto.duration_seconds ?? null,
        dto.mood ?? null,
      ],
    );

    return this.toPublic(rows[0]);
  }

  // ── List Entries ───────────────────────────────────────────────────────────

  async listEntries(
    userId: string,
    dto: ListJournalDto,
  ): Promise<JournalPageResult> {
    const limit = dto.limit ?? 20;
    const filter = dto.filter ?? 'all';

    // SECURITY: user_id = $1 is always the first param and always present
    const params: unknown[] = [userId];
    let where = `WHERE user_id = $1 AND deleted_at IS NULL AND upload_status = 'completed'`;

    if (filter === 'voice')   where += ` AND entry_type = 'voice'`;
    if (filter === 'video')   where += ` AND entry_type = 'video'`;
    if (filter === 'text')    where += ` AND entry_type = 'text'`;
    if (filter === 'starred') where += ` AND is_starred = true`;

    if (dto.cursor) {
      const decoded = decodeCursor(dto.cursor);
      if (decoded) {
        const p1 = params.length + 1;
        const p2 = params.length + 2;
        where += ` AND (recorded_at < $${p1} OR (recorded_at = $${p1} AND id < $${p2}))`;
        params.push(decoded.recordedAt, decoded.id);
      }
    }

    params.push(limit + 1);

    const rows = await this.db.query<DbEntry[]>(
      `SELECT id, user_id, entry_type, text_content, duration_seconds,
              mood, is_starred, recorded_at, created_at,
              media_key, deleted_at
       FROM personal_journal_entries
       ${where}
       ORDER BY recorded_at DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );

    const has_more = rows.length > limit;
    const entries = has_more ? rows.slice(0, limit) : rows;
    const last = entries[entries.length - 1];

    const next_cursor =
      has_more && last
        ? encodeCursor(new Date(last.recorded_at), last.id)
        : null;

    return {
      entries: entries.map((e) => this.toPublic(e)),
      next_cursor,
      has_more,
    };
  }

  // ── Get Single Entry ───────────────────────────────────────────────────────

  async getEntry(
    userId: string,
    entryId: string,
  ): Promise<JournalEntryWithUrl> {
    // SECURITY: user_id = $2 ensures only the owner can access this entry
    const rows = await this.db.query<DbEntry[]>(
      `SELECT id, user_id, entry_type, media_key, text_content,
              duration_seconds, mood, is_starred, recorded_at, created_at
       FROM personal_journal_entries
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [entryId, userId],
    );

    if (!rows.length) {
      throw new NotFoundException({
        error: 'JOURNAL_ENTRY_NOT_FOUND',
        message: 'Journal entry not found.',
      });
    }

    const entry = rows[0];
    const media_url = entry.media_key
      ? await this.storage
          .getSignedDownloadUrl(entry.media_key, 3600)
          .catch(() => null)
      : null;

    return { ...this.toPublic(entry), media_url };
  }

  // ── Star / Unstar ──────────────────────────────────────────────────────────

  async starEntry(
    userId: string,
    entryId: string,
    isStarred: boolean,
  ): Promise<JournalEntry> {
    // SECURITY: user_id = $3
    const rows = returningRows<DbEntry>(await this.db.query(
      `UPDATE personal_journal_entries
       SET is_starred = $1,
           starred_at = CASE WHEN $1 = true THEN NOW() ELSE NULL END
       WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL
       RETURNING id, user_id, entry_type, text_content, duration_seconds,
                 mood, is_starred, recorded_at, created_at`,
      [isStarred, entryId, userId],
    ));

    if (!rows.length) {
      throw new NotFoundException({
        error: 'JOURNAL_ENTRY_NOT_FOUND',
        message: 'Journal entry not found.',
      });
    }

    return this.toPublic(rows[0]);
  }

  // ── Soft Delete ────────────────────────────────────────────────────────────

  async deleteEntry(userId: string, entryId: string): Promise<void> {
    // SECURITY: user_id = $2 — user can only delete their own entries
    // Soft delete only — same policy as shared diary
    const result = returningRows<{ id: string }>(await this.db.query(
      `UPDATE personal_journal_entries
       SET deleted_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [entryId, userId],
    ));

    if (!result.length) {
      throw new NotFoundException({
        error: 'JOURNAL_ENTRY_NOT_FOUND',
        message: 'Journal entry not found.',
      });
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private toPublic(entry: DbEntry): JournalEntry {
    // Never expose media_key in list/detail responses — signed URL generated separately
    return {
      id: entry.id,
      user_id: entry.user_id,
      entry_type: entry.entry_type,
      text_content: entry.text_content,
      duration_seconds: entry.duration_seconds,
      mood: entry.mood,
      is_starred: entry.is_starred,
      recorded_at: entry.recorded_at,
      created_at: entry.created_at,
    };
  }
}
