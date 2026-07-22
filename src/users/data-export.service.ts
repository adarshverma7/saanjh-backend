import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StorageService } from '../shared/storage/storage.service';
import { maskPhone } from '../shared/helpers/phone.helper';

// A data export download link is valid for 7 days — the SigV4 presigned URL
// maximum. The notification tells the user to download within that window.
const EXPORT_URL_TTL = 7 * 24 * 60 * 60; // 604800s

interface DbUserRow {
  id: string;
  phone: string;
  name: string | null;
  language: string;
  timezone: string;
  created_at: Date;
}

interface DbDiaryRow {
  id: string;
  connection_id: string;
  entry_type: string;
  transcription: string | null;
  mood: string | null;
  duration_seconds: number | null;
  is_starred: boolean;
  media_key: string;
  recorded_at: Date;
  created_at: Date;
}

interface DbJournalRow {
  id: string;
  entry_type: string | null;
  text_content: string | null;
  duration_seconds: number | null;
  media_key: string | null;
  created_at: Date;
}

/**
 * Builds a machine-readable (JSON) export of everything a user owns — profile,
 * shared diary memories they authored, and personal journal entries — uploads
 * it to storage, and notifies the user with a time-limited download link.
 *
 * DPDP/GDPR data-portability. Runs inline (fire-and-forget from the request);
 * no Redis required. Media blobs are referenced by presigned download URLs
 * (computed locally, so exporting many entries stays cheap).
 */
@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly storage: StorageService,
  ) {}

  async generateExport(userId: string): Promise<void> {
    this.logger.log(`Building data export for user ${userId}`);

    const userRows = await this.db.query<DbUserRow[]>(
      `SELECT id, phone, name, language, timezone, created_at
       FROM users WHERE id = $1`,
      [userId],
    );
    if (!userRows.length) {
      this.logger.warn(`Data export: user ${userId} not found — skipping`);
      return;
    }
    const user = userRows[0];

    const diaryRows = await this.db.query<DbDiaryRow[]>(
      `SELECT id, connection_id, entry_type, transcription, mood,
              duration_seconds, is_starred, media_key, recorded_at, created_at
       FROM diary_entries
       WHERE author_id = $1 AND deleted_at IS NULL
       ORDER BY recorded_at ASC`,
      [userId],
    );

    const journalRows = await this.db.query<DbJournalRow[]>(
      `SELECT id, entry_type, text_content, duration_seconds, media_key, created_at
       FROM personal_journal_entries
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [userId],
    );

    const diaryEntries = await Promise.all(
      diaryRows.map(async (e) => ({
        id: e.id,
        connection_id: e.connection_id,
        type: e.entry_type,
        transcription: e.transcription,
        mood: e.mood,
        duration_seconds: e.duration_seconds,
        starred: e.is_starred,
        recorded_at: e.recorded_at,
        created_at: e.created_at,
        media_download_url: await this.signMedia(e.media_key),
      })),
    );

    const journalEntries = await Promise.all(
      journalRows.map(async (e) => ({
        id: e.id,
        type: e.entry_type,
        text: e.text_content,
        duration_seconds: e.duration_seconds,
        created_at: e.created_at,
        media_download_url: await this.signMedia(e.media_key),
      })),
    );

    const bundle = {
      export_version: 1,
      generated_at: new Date().toISOString(),
      note: 'Media download links are valid for 7 days from generation.',
      profile: {
        id: user.id,
        phone: maskPhone(user.phone),
        name: user.name,
        language: user.language,
        timezone: user.timezone,
        joined_at: user.created_at,
      },
      diary_memories: diaryEntries,
      personal_journal: journalEntries,
      counts: {
        diary_memories: diaryEntries.length,
        personal_journal: journalEntries.length,
      },
    };

    const key = StorageService.exportKey(userId);
    const body = Buffer.from(JSON.stringify(bundle, null, 2), 'utf-8');
    await this.storage.putObject(key, body, 'application/json');

    const downloadUrl = await this.storage.getSignedDownloadUrl(key, EXPORT_URL_TTL);
    const expiresAt = new Date(Date.now() + EXPORT_URL_TTL * 1000).toISOString();

    // Deliver an in-app notification carrying the link. Insert directly (rather
    // than via NotificationsService) because this is a system notification with
    // no user-facing on/off preference to gate it.
    await this.db
      .query(
        `INSERT INTO notifications (user_id, type, title, body, data)
         VALUES ($1, 'data_export', $2, $3, $4)`,
        [
          userId,
          'Your data export is ready',
          'Tap to download. The link is valid for 7 days.',
          JSON.stringify({
            download_url: downloadUrl,
            expires_at: expiresAt,
            format: 'json',
            entry_count: diaryEntries.length + journalEntries.length,
          }),
        ],
      )
      .catch((err: unknown) =>
        this.logger.error(`Failed to insert export notification for ${userId}`, err),
      );

    await this.db
      .query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'user.data_export_completed', 'user', $1, $2)`,
        [userId, JSON.stringify({ key, entry_count: diaryEntries.length + journalEntries.length })],
      )
      .catch(() => {});

    this.logger.log(
      `Data export ready for user ${userId}: ${key} ` +
        `(${diaryEntries.length} diary + ${journalEntries.length} journal)`,
    );
  }

  /** Presign a media object; null keys and signing failures yield null. */
  private async signMedia(key: string | null): Promise<string | null> {
    if (!key) return null;
    return this.storage
      .getSignedDownloadUrl(key, EXPORT_URL_TTL)
      .catch(() => null);
  }
}
