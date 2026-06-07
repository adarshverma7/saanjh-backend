import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';

/**
 * Scheduled maintenance tasks — all run on IST-aligned schedules.
 *
 * Bull queue jobs are added for operations that need persistence/retry.
 * Without Redis, queue.add() calls are silently skipped — the cron still
 * fires, but jobs that require Bull fall back gracefully.
 */
@Injectable()
export class ScheduledTasksService {
  private readonly logger = new Logger(ScheduledTasksService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Optional() @InjectQueue('cleanup') private readonly cleanupQueue: Queue | null,
  ) {}

  // ── Runs daily at midnight IST (18:30 UTC) ────────────────────────────────

  /**
   * Purge OTP records older than 1 hour past expiry.
   * Keeps the otp_verifications table lean.
   */
  @Cron('30 18 * * *', { timeZone: 'Asia/Kolkata' })
  async cleanupExpiredOtps(): Promise<void> {
    try {
      const result = await this.db.query<{ rowsAffected: number }>(
        `DELETE FROM otp_verifications WHERE expires_at < NOW() - INTERVAL '1 hour'`,
      );
      this.logger.log(`Cleaned up OTP records: ${JSON.stringify(result)}`);
    } catch (err: unknown) {
      this.logger.error('cleanupExpiredOtps failed', err);
    }
  }

  /**
   * Mark pending invites as expired when their 7-day window has passed.
   */
  @Cron('35 18 * * *', { timeZone: 'Asia/Kolkata' })
  async cleanupExpiredInvites(): Promise<void> {
    try {
      await this.db.query(
        `UPDATE invites
         SET status = 'expired'
         WHERE status = 'pending' AND expires_at < NOW()`,
      );
      this.logger.log('Expired invites marked');
    } catch (err: unknown) {
      this.logger.error('cleanupExpiredInvites failed', err);
    }
  }

  // ── Runs daily at 2 AM IST (20:30 UTC prior day) — low traffic window ────

  /**
   * Queue R2 media deletion for diary entries soft-deleted more than 90 days ago.
   * Sets media_key = NULL after queuing to prevent double-deletion.
   *
   * Voice memories are never immediately destroyed — they get a 90-day grace period
   * so users can reconsider after deleting an entry.
   */
  @Cron('30 20 * * *', { timeZone: 'Asia/Kolkata' })
  async cleanupOrphanedMedia(): Promise<void> {
    try {
      const entries = await this.db.query<
        { id: string; media_key: string; thumbnail_key: string | null }[]
      >(
        `SELECT id, media_key, thumbnail_key
         FROM diary_entries
         WHERE deleted_at < NOW() - INTERVAL '90 days'
           AND media_key IS NOT NULL`,
      );

      if (!entries.length) return;

      this.logger.log(`Queuing media cleanup for ${entries.length} entries`);

      for (const entry of entries) {
        // Null out the keys immediately to prevent double-deletion
        await this.db.query(
          `UPDATE diary_entries
           SET media_key = NULL, thumbnail_key = NULL, updated_at = NOW()
           WHERE id = $1`,
          [entry.id],
        );

        if (this.cleanupQueue) {
          await this.cleanupQueue
            .add(
              'delete_media',
              { mediaKey: entry.media_key, thumbnailKey: entry.thumbnail_key },
              { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
            )
            .catch((err: unknown) =>
              this.logger.warn(`Failed to queue media deletion for entry ${entry.id}`, err),
            );
        }
      }
    } catch (err: unknown) {
      this.logger.error('cleanupOrphanedMedia failed', err);
    }
  }

  /**
   * Mark pending uploads older than 2 hours as failed.
   * Prevents ghost rows from clogging the diary thread if Flutter crashed mid-upload.
   * Runs at 3 AM IST (21:30 UTC).
   */
  @Cron('30 21 * * *', { timeZone: 'Asia/Kolkata' })
  async cleanupStalePendingUploads(): Promise<void> {
    try {
      const diaryResult = await this.db.query<{ rowCount: number }[]>(
        `UPDATE diary_entries
         SET upload_status = 'failed', updated_at = NOW()
         WHERE upload_status = 'pending'
           AND created_at < NOW() - INTERVAL '2 hours'`,
      );
      const journalResult = await this.db.query<{ rowCount: number }[]>(
        `UPDATE personal_journal_entries
         SET upload_status = 'failed'
         WHERE upload_status = 'pending'
           AND created_at < NOW() - INTERVAL '2 hours'`,
      );
      this.logger.log(
        `Stale pending uploads expired — diary: ${JSON.stringify(diaryResult)}, journal: ${JSON.stringify(journalResult)}`,
      );
    } catch (err: unknown) {
      this.logger.error('cleanupStalePendingUploads failed', err);
    }
  }

  /**
   * Queue hard deletion for accounts that have been soft-deleted for 30+ days.
   * Gives users a 30-day grace period to cancel their deletion request by logging back in.
   */
  @Cron('45 20 * * *', { timeZone: 'Asia/Kolkata' })
  async hardDeleteScheduledAccounts(): Promise<void> {
    try {
      const users = await this.db.query<{ id: string; deleted_at: Date }[]>(
        `SELECT id, deleted_at FROM users
         WHERE deleted_at IS NOT NULL
           AND deleted_at < NOW() - INTERVAL '30 days'`,
      );

      if (!users.length) return;

      this.logger.log(`Queuing hard delete for ${users.length} accounts`);

      for (const user of users) {
        if (this.cleanupQueue) {
          await this.cleanupQueue
            .add(
              'delete_user_data',
              { userId: user.id },
              {
                attempts: 3,
                backoff: { type: 'fixed', delay: 60_000 },
                // Delay by 1 minute to stagger deletes and avoid DB overload
                delay: users.indexOf(user) * 60_000,
              },
            )
            .catch((err: unknown) =>
              this.logger.warn(`Failed to queue account delete for ${user.id}`, err),
            );
        } else {
          this.logger.warn(
            `Redis not available — hard delete for ${user.id} will retry next cron run`,
          );
        }
      }
    } catch (err: unknown) {
      this.logger.error('hardDeleteScheduledAccounts failed', err);
    }
  }
}
