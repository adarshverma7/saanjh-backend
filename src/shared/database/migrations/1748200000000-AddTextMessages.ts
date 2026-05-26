import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTextMessages1748200000000 implements MigrationInterface {
  name = 'AddTextMessages1748200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // media_key is NULL for text entries
    await queryRunner.query(`
      ALTER TABLE diary_entries ALTER COLUMN media_key DROP NOT NULL
    `);

    // Text message body (2000-char limit enforced at API layer)
    await queryRunner.query(`
      ALTER TABLE diary_entries ADD COLUMN IF NOT EXISTS content TEXT
    `);

    // Whether a text entry has been intentionally saved to the Memory Tree.
    // Audio/video always appear in Moments; text only appears when this is true.
    await queryRunner.query(`
      ALTER TABLE diary_entries
        ADD COLUMN IF NOT EXISTS saved_to_moments     BOOLEAN    NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS saved_to_moments_at  TIMESTAMPTZ
    `);

    // Partial index to make Moments queries efficient
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_entries_moments"
        ON diary_entries(connection_id, recorded_at DESC)
        WHERE deleted_at IS NULL
          AND (entry_type != 'text' OR saved_to_moments = true)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_entries_moments"`);
    await queryRunner.query(`ALTER TABLE diary_entries DROP COLUMN IF EXISTS saved_to_moments_at`);
    await queryRunner.query(`ALTER TABLE diary_entries DROP COLUMN IF EXISTS saved_to_moments`);
    await queryRunner.query(`ALTER TABLE diary_entries DROP COLUMN IF EXISTS content`);
    await queryRunner.query(`ALTER TABLE diary_entries ALTER COLUMN media_key SET NOT NULL`);
  }
}
