import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Idempotency key for message sends. The client generates a stable id per
 * message and reuses it across retries, so a send that reached the server but
 * whose response was lost (connectivity drop) can be retried without creating a
 * duplicate row. Nullable + partial unique index keeps it backward compatible:
 * legacy clients that don't send the key behave exactly as before.
 */
export class AddClientMsgId1748400000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE diary_entries
      ADD COLUMN IF NOT EXISTS client_msg_id VARCHAR(64)
    `);

    // One row per (connection, client_msg_id) — enforced only when the key is
    // present, so rows from legacy clients (NULL) are unaffected.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_diary_entries_client_msg_id
        ON diary_entries (connection_id, client_msg_id)
        WHERE client_msg_id IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_diary_entries_client_msg_id`);
    await queryRunner.query(`
      ALTER TABLE diary_entries
      DROP COLUMN IF EXISTS client_msg_id
    `);
  }
}
