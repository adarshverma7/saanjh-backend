import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Messaging-action layer: emoji reactions, per-entry pinning, captions,
 * forwarding lineage, per-user hide (delete-for-me), and user blocks/reports.
 *
 * - reactions:      {"❤️": ["userId", ...], ...} — one reaction per user total,
 *                   enforced in service code.
 * - hidden_for:     users who deleted the entry "for me" — filtered out of
 *                   reads for that user only.
 * - forwarded_from: original entry id when this entry was forwarded (media_key
 *                   is shared; captured media is never re-uploaded or edited).
 */
export class MessagingActions1748600000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE diary_entries
        ADD COLUMN IF NOT EXISTS reactions      JSONB        NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS is_pinned      BOOLEAN      NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS pinned_at      TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS caption        TEXT,
        ADD COLUMN IF NOT EXISTS forwarded_from UUID,
        ADD COLUMN IF NOT EXISTS hidden_for     UUID[]       NOT NULL DEFAULT '{}'
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS user_blocks (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (blocker_id, blocked_id)
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_user_blocks_pair ON user_blocks (blocker_id, blocked_id)`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS user_reports (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reported_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason      VARCHAR(50) NOT NULL,
        details     TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS user_reports`);
    await q.query(`DROP TABLE IF EXISTS user_blocks`);
    await q.query(`
      ALTER TABLE diary_entries
        DROP COLUMN IF EXISTS reactions,
        DROP COLUMN IF EXISTS is_pinned,
        DROP COLUMN IF EXISTS pinned_at,
        DROP COLUMN IF EXISTS caption,
        DROP COLUMN IF EXISTS forwarded_from,
        DROP COLUMN IF EXISTS hidden_for
    `);
  }
}
