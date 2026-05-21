import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { StorageService } from '../shared/storage/storage.service';

interface DeleteMediaPayload {
  mediaKey: string;
  thumbnailKey?: string;
}

interface DeleteUserDataPayload {
  userId: string;
}

/**
 * Handles irreversible cleanup operations.
 * All operations are idempotent — safe to retry if the job fails midway.
 *
 * Note: This worker requires Redis/Bull for scheduling delayed jobs.
 * Without Redis (MVP), the @Cron handlers in ScheduledTasksService still
 * queue jobs for execution — they'll run when Redis is connected.
 */
@Processor('cleanup')
@Injectable()
export class CleanupWorker {
  private readonly logger = new Logger(CleanupWorker.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly storage: StorageService,
  ) {}

  // ── Delete media from R2 ───────────────────────────────────────────────────

  @Process('delete_media')
  async deleteMedia(job: Job<DeleteMediaPayload>): Promise<void> {
    const { mediaKey, thumbnailKey } = job.data;

    try {
      await this.storage.deleteObject(mediaKey);
      this.logger.log(`Deleted media: ${mediaKey}`);
    } catch (err: unknown) {
      this.logger.error(`Failed to delete media ${mediaKey}`, err);
      throw err; // Let Bull retry
    }

    if (thumbnailKey) {
      try {
        await this.storage.deleteObject(thumbnailKey);
        this.logger.log(`Deleted thumbnail: ${thumbnailKey}`);
      } catch {
        // Thumbnail deletion failure is non-critical — don't retry the whole job
        this.logger.warn(`Failed to delete thumbnail ${thumbnailKey} (non-fatal)`);
      }
    }
  }

  // ── Hard delete user data (GDPR/DPDP — runs 30 days after deletion request) ─

  @Process('delete_user_data')
  async deleteUserData(job: Job<DeleteUserDataPayload>): Promise<void> {
    const { userId } = job.data;

    this.logger.log(`Starting hard delete for user ${userId}`);

    // Verify user has been soft-deleted for at least 30 days
    const userRows = await this.db.query<{ deleted_at: Date | null }[]>(
      `SELECT deleted_at FROM users WHERE id = $1`,
      [userId],
    );

    if (!userRows.length) {
      this.logger.warn(`Hard delete: user ${userId} not found — already deleted?`);
      return;
    }

    const { deleted_at } = userRows[0];
    if (!deleted_at) {
      this.logger.warn(`Hard delete: user ${userId} was not soft-deleted — skipping`);
      return;
    }

    const daysSinceDeletion =
      (Date.now() - new Date(deleted_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceDeletion < 29) {
      this.logger.warn(
        `Hard delete: user ${userId} deleted ${daysSinceDeletion.toFixed(1)} days ago — too soon, skipping`,
      );
      return;
    }

    // Step 1: Collect personal journal media keys before deleting rows
    const journalMedia = await this.db.query<{ media_key: string }[]>(
      `SELECT media_key FROM personal_journal_entries
       WHERE user_id = $1 AND media_key IS NOT NULL`,
      [userId],
    );

    // Step 2: Hard delete personal data
    await this.db.query(
      `DELETE FROM personal_journal_entries WHERE user_id = $1`,
      [userId],
    );
    await this.db.query(
      `DELETE FROM device_sessions WHERE user_id = $1`,
      [userId],
    );
    await this.db.query(
      `DELETE FROM otp_verifications WHERE phone = (SELECT phone FROM users WHERE id = $1)`,
      [userId],
    );
    await this.db.query(
      `DELETE FROM notification_preferences WHERE user_id = $1`,
      [userId],
    );
    await this.db.query(
      `DELETE FROM invites WHERE inviter_id = $1 AND status != 'accepted'`,
      [userId],
    );

    // Step 3: Anonymise shared diary entries — partner still owns their copy
    // Set author_id to NULL rather than deleting rows (partner's emotional data is safe)
    await this.db.query(
      `UPDATE diary_entries SET author_id = NULL, updated_at = NOW()
       WHERE author_id = $1`,
      [userId],
    );

    // Step 4: Hard delete the user row
    await this.db.query(`DELETE FROM users WHERE id = $1`, [userId]);

    // Step 5: Queue R2 media deletions for personal journal files
    // These run asynchronously — failure is acceptable (storage billing is minimal)
    for (const { media_key } of journalMedia) {
      this.storage.deleteObject(media_key).catch((err: unknown) => {
        this.logger.warn(`Failed to delete journal media ${media_key}`, err);
      });
    }

    // Step 6: Audit log (user row is gone — use NULL user_id)
    await this.db.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata)
       VALUES (NULL, 'account.hard_deleted', 'user', $1, $2)`,
      [userId, JSON.stringify({ requested_at: deleted_at })],
    );

    this.logger.log(`Hard delete complete for user ${userId}`);
  }
}
