import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Flicker Stories — Instagram-style 24-hour stories.
 *
 * - stories:      one row per posted story. Two-step upload like diary
 *                 entries (request-upload → confirm); expires_at is set at
 *                 confirm time to created + 24 h. Reads always filter
 *                 expires_at > NOW(), so expiry needs no background job.
 * - story_views:  one row per (story, viewer) — powers the viewed/unviewed
 *                 ring state and the author's viewer list.
 */
export class FlickerStories1748700000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS stories (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        media_key        TEXT NOT NULL,
        media_type       VARCHAR(10) NOT NULL,
        caption          TEXT,
        duration_seconds SMALLINT,
        upload_status    VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at       TIMESTAMPTZ,
        deleted_at       TIMESTAMPTZ
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_stories_user_active
       ON stories (user_id, expires_at)
       WHERE deleted_at IS NULL`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS story_views (
        story_id  UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
        viewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (story_id, viewer_id)
      )
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS story_views`);
    await q.query(`DROP TABLE IF EXISTS stories`);
  }
}
