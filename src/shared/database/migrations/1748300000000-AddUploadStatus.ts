import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUploadStatus1748300000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // Add upload_status to diary_entries.
    // DEFAULT 'completed' ensures all existing rows (already confirmed) get the right value.
    await queryRunner.query(`
      ALTER TABLE diary_entries
      ADD COLUMN IF NOT EXISTS upload_status VARCHAR(20) NOT NULL DEFAULT 'completed'
        CONSTRAINT diary_entries_upload_status_check
          CHECK (upload_status IN ('pending', 'completed', 'failed'))
    `);

    // Partial index — only pending rows are ever scanned by the cleanup cron
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_diary_entries_pending_upload
        ON diary_entries (created_at)
        WHERE upload_status = 'pending'
    `);

    // Same for personal_journal_entries
    await queryRunner.query(`
      ALTER TABLE personal_journal_entries
      ADD COLUMN IF NOT EXISTS upload_status VARCHAR(20) NOT NULL DEFAULT 'completed'
        CONSTRAINT personal_journal_entries_upload_status_check
          CHECK (upload_status IN ('pending', 'completed', 'failed'))
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_journal_entries_pending_upload
        ON personal_journal_entries (created_at)
        WHERE upload_status = 'pending'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_diary_entries_pending_upload`);
    await queryRunner.query(`
      ALTER TABLE diary_entries
      DROP COLUMN IF EXISTS upload_status
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS idx_journal_entries_pending_upload`);
    await queryRunner.query(`
      ALTER TABLE personal_journal_entries
      DROP COLUMN IF EXISTS upload_status
    `);
  }
}
