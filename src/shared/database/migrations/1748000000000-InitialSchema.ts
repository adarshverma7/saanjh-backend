import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1748000000000 implements MigrationInterface {
  name = 'InitialSchema1748000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─── Enable UUID extension ────────────────────────────────────────────────
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // ─── users ────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "phone"         VARCHAR(15)  UNIQUE NOT NULL,
        "phone_hash"    VARCHAR(64)  NOT NULL,
        "name"          VARCHAR(100),
        "avatar_key"    TEXT,
        "language"      VARCHAR(10)  NOT NULL DEFAULT 'en',
        "timezone"      VARCHAR(50)  NOT NULL DEFAULT 'Asia/Kolkata',
        "date_of_birth" DATE,
        "is_onboarded"  BOOLEAN      NOT NULL DEFAULT false,
        "is_verified"   BOOLEAN      NOT NULL DEFAULT false,
        "is_active"     BOOLEAN      NOT NULL DEFAULT true,
        "last_active_at" TIMESTAMPTZ,
        "created_at"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "updated_at"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "deleted_at"    TIMESTAMPTZ
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_users_phone_hash"
        ON "users"("phone_hash")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_users_last_active"
        ON "users"("last_active_at")
        WHERE "deleted_at" IS NULL
    `);

    // ─── diary_connections ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "diary_connections" (
        "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_a_id"         UUID NOT NULL REFERENCES "users"("id"),
        "user_b_id"         UUID NOT NULL REFERENCES "users"("id"),
        "relationship_type" VARCHAR(30),
        "initiated_by"      UUID REFERENCES "users"("id"),
        "status"            VARCHAR(20)  NOT NULL DEFAULT 'pending',
        "name_for_a"        VARCHAR(100),
        "name_for_b"        VARCHAR(100),
        "streak_count"      INTEGER      NOT NULL DEFAULT 0,
        "longest_streak"    INTEGER      NOT NULL DEFAULT 0,
        "streak_last_date"  DATE,
        "streak_started_at" DATE,
        "diary_weather"     VARCHAR(20)  NOT NULL DEFAULT 'sunny',
        "last_entry_at"     TIMESTAMPTZ,
        "total_entry_count" INTEGER      NOT NULL DEFAULT 0,
        "created_at"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "updated_at"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
        CONSTRAINT "uq_connection_pair" UNIQUE ("user_a_id", "user_b_id"),
        CONSTRAINT "chk_pair_order"     CHECK  ("user_a_id" < "user_b_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_conn_a"
        ON "diary_connections"("user_a_id")
        WHERE "status" = 'active'
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_conn_b"
        ON "diary_connections"("user_b_id")
        WHERE "status" = 'active'
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_conn_weather"
        ON "diary_connections"("diary_weather", "last_entry_at")
    `);

    // ─── diary_entries ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "diary_entries" (
        "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "connection_id"         UUID NOT NULL REFERENCES "diary_connections"("id") ON DELETE CASCADE,
        "author_id"             UUID NOT NULL REFERENCES "users"("id"),
        "entry_type"            VARCHAR(10)  NOT NULL,
        "media_key"             TEXT         NOT NULL,
        "duration_seconds"      SMALLINT,
        "file_size_bytes"       INTEGER,
        "thumbnail_key"         TEXT,
        "transcription"         TEXT,
        "transcription_status"  VARCHAR(20)  NOT NULL DEFAULT 'pending',
        "mood"                  VARCHAR(20),
        "is_starred"            BOOLEAN      NOT NULL DEFAULT false,
        "starred_at"            TIMESTAMPTZ,
        "play_count"            SMALLINT     NOT NULL DEFAULT 0,
        "recorded_at"           TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "created_at"            TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "updated_at"            TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "deleted_at"            TIMESTAMPTZ
      )
    `);
    // Primary thread query — newest first, excludes deleted
    await queryRunner.query(`
      CREATE INDEX "idx_entries_thread"
        ON "diary_entries"("connection_id", "recorded_at" DESC)
        WHERE "deleted_at" IS NULL
    `);
    // Author lookup
    await queryRunner.query(`
      CREATE INDEX "idx_entries_author"
        ON "diary_entries"("author_id", "recorded_at" DESC)
        WHERE "deleted_at" IS NULL
    `);
    // Memory Jar — starred entries
    await queryRunner.query(`
      CREATE INDEX "idx_entries_starred"
        ON "diary_entries"("connection_id", "starred_at" DESC)
        WHERE "is_starred" = true AND "deleted_at" IS NULL
    `);
    // On This Day — match on month + day, ignoring year
    await queryRunner.query(`
      CREATE INDEX "idx_entries_anniversary"
        ON "diary_entries"("connection_id", "recorded_at")
        WHERE "deleted_at" IS NULL
    `);
    // Memory Tree — monthly aggregation
    await queryRunner.query(`
      CREATE INDEX "idx_entries_monthly"
        ON "diary_entries"("connection_id", "recorded_at")
        WHERE "deleted_at" IS NULL
    `);
    // Full-text search on transcriptions
    await queryRunner.query(`
      CREATE INDEX "idx_entries_fts"
        ON "diary_entries" USING GIN(
          to_tsvector('english', COALESCE("transcription", ''))
        )
        WHERE "deleted_at" IS NULL
    `);

    // ─── flicker_events ───────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "flicker_events" (
        "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "connection_id"      UUID NOT NULL REFERENCES "diary_connections"("id"),
        "sender_id"          UUID NOT NULL REFERENCES "users"("id"),
        "receiver_id"        UUID NOT NULL REFERENCES "users"("id"),
        "sent_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
        "delivered_at"       TIMESTAMPTZ,
        "is_mutual"          BOOLEAN NOT NULL DEFAULT false,
        "mutual_at"          TIMESTAMPTZ,
        "mutual_window_secs" INTEGER NOT NULL DEFAULT 300
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_flicker_connection"
        ON "flicker_events"("connection_id", "sent_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_flicker_receiver"
        ON "flicker_events"("receiver_id", "sent_at" DESC)
    `);
    // Used for mutual reveal check — find if receiver sent back within window
    await queryRunner.query(`
      CREATE INDEX "idx_flicker_window"
        ON "flicker_events"("sender_id", "receiver_id", "sent_at" DESC)
    `);

    // ─── personal_journal_entries ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "personal_journal_entries" (
        "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"          UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "entry_type"       VARCHAR(10),
        "media_key"        TEXT,
        "text_content"     TEXT,
        "duration_seconds" SMALLINT,
        "mood"             VARCHAR(20),
        "is_starred"       BOOLEAN     NOT NULL DEFAULT false,
        "recorded_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
        "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"       TIMESTAMPTZ
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_personal_user"
        ON "personal_journal_entries"("user_id", "recorded_at" DESC)
        WHERE "deleted_at" IS NULL
    `);

    // ─── streak_milestones ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "streak_milestones" (
        "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "connection_id"  UUID NOT NULL REFERENCES "diary_connections"("id"),
        "milestone_days" INTEGER NOT NULL,
        "achieved_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
        "seen_by_a"      BOOLEAN NOT NULL DEFAULT false,
        "seen_by_b"      BOOLEAN NOT NULL DEFAULT false,
        CONSTRAINT "uq_milestone" UNIQUE ("connection_id", "milestone_days")
      )
    `);

    // ─── notifications ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"     UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "type"        VARCHAR(50)  NOT NULL,
        "title"       TEXT,
        "body"        TEXT,
        "data"        JSONB,
        "is_read"     BOOLEAN      NOT NULL DEFAULT false,
        "read_at"     TIMESTAMPTZ,
        "push_status" VARCHAR(20)  NOT NULL DEFAULT 'pending',
        "push_error"  TEXT,
        "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_notif_user_unread"
        ON "notifications"("user_id", "created_at" DESC)
        WHERE "is_read" = false
    `);

    // ─── notification_preferences ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "notification_preferences" (
        "user_id"              UUID PRIMARY KEY REFERENCES "users"("id"),
        "new_entry"            BOOLEAN NOT NULL DEFAULT true,
        "flicker_received"     BOOLEAN NOT NULL DEFAULT true,
        "streak_reminder"      BOOLEAN NOT NULL DEFAULT true,
        "streak_reminder_time" TIME    NOT NULL DEFAULT '20:00:00',
        "occasion_reminders"   BOOLEAN NOT NULL DEFAULT true,
        "morning_ritual"       BOOLEAN NOT NULL DEFAULT true,
        "morning_ritual_time"  TIME    NOT NULL DEFAULT '08:00:00',
        "quiet_hours_start"    TIME    NOT NULL DEFAULT '22:00:00',
        "quiet_hours_end"      TIME    NOT NULL DEFAULT '07:00:00',
        "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ─── occasions ────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "occasions" (
        "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "connection_id"     UUID NOT NULL REFERENCES "diary_connections"("id"),
        "created_by"        UUID NOT NULL REFERENCES "users"("id"),
        "occasion_type"     VARCHAR(30) NOT NULL,
        "occasion_name"     VARCHAR(100),
        "occasion_date"     DATE        NOT NULL,
        "is_recurring"      BOOLEAN     NOT NULL DEFAULT true,
        "remind_days_before" INTEGER    NOT NULL DEFAULT 3,
        "last_reminded_year" INTEGER,
        "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Cron job queries this daily — match on month+day regardless of year
    await queryRunner.query(`
      CREATE INDEX "idx_occasions_upcoming"
        ON "occasions"("connection_id", "occasion_date")
    `);

    // ─── occasion_ai_messages ─────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "occasion_ai_messages" (
        "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "connection_id"  UUID REFERENCES "diary_connections"("id"),
        "occasion_id"    UUID REFERENCES "occasions"("id"),
        "occasion_type"  VARCHAR(30),
        "prompt_used"    TEXT,
        "generated_text" TEXT,
        "language"       VARCHAR(10) NOT NULL DEFAULT 'en',
        "model_used"     VARCHAR(50),
        "used_at"        TIMESTAMPTZ,
        "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ─── memory_book_orders ───────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "memory_book_orders" (
        "id"                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "connection_id"        UUID NOT NULL REFERENCES "diary_connections"("id"),
        "ordered_by"           UUID NOT NULL REFERENCES "users"("id"),
        "order_type"           VARCHAR(10) NOT NULL DEFAULT 'self',
        "gift_recipient_name"  VARCHAR(100),
        "gift_recipient_phone" VARCHAR(15),
        "date_from"            DATE NOT NULL,
        "date_to"              DATE NOT NULL,
        "entry_count"          INTEGER,
        "amount_paise"         INTEGER NOT NULL,
        "currency"             VARCHAR(3) NOT NULL DEFAULT 'INR',
        "razorpay_order_id"    VARCHAR(100),
        "razorpay_payment_id"  VARCHAR(100),
        "payment_status"       VARCHAR(20) NOT NULL DEFAULT 'pending',
        "paid_at"              TIMESTAMPTZ,
        "pdf_key"              TEXT,
        "print_status"         VARCHAR(20) NOT NULL DEFAULT 'not_started',
        "shipping_address"     JSONB,
        "tracking_number"      VARCHAR(100),
        "created_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ─── invites ──────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "invites" (
        "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "inviter_id"         UUID NOT NULL REFERENCES "users"("id"),
        "invite_code"        VARCHAR(12) NOT NULL UNIQUE,
        "invited_phone"      VARCHAR(15),
        "invited_phone_hash" VARCHAR(64),
        "relationship_type"  VARCHAR(30),
        "connection_name"    VARCHAR(100),
        "status"             VARCHAR(20) NOT NULL DEFAULT 'pending',
        "accepted_by"        UUID REFERENCES "users"("id"),
        "accepted_at"        TIMESTAMPTZ,
        "click_count"        INTEGER     NOT NULL DEFAULT 0,
        "expires_at"         TIMESTAMPTZ NOT NULL,
        "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_invites_phone_hash"
        ON "invites"("invited_phone_hash")
        WHERE "status" = 'pending'
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_invites_inviter"
        ON "invites"("inviter_id", "created_at" DESC)
    `);

    // ─── device_sessions ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "device_sessions" (
        "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"            UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "device_id"          VARCHAR(100) NOT NULL,
        "device_type"        VARCHAR(10),
        "fcm_token"          TEXT,
        "app_version"        VARCHAR(20),
        "os_version"         VARCHAR(20),
        "is_active"          BOOLEAN     NOT NULL DEFAULT true,
        "refresh_token_hash" VARCHAR(64),
        "last_used_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
        "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "uq_user_device" UNIQUE ("user_id", "device_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_sessions_user_active"
        ON "device_sessions"("user_id")
        WHERE "is_active" = true
    `);

    // ─── otp_verifications ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "otp_verifications" (
        "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "phone"         VARCHAR(15)  NOT NULL,
        "otp_hash"      VARCHAR(64)  NOT NULL,
        "purpose"       VARCHAR(20)  NOT NULL DEFAULT 'login',
        "attempt_count" SMALLINT     NOT NULL DEFAULT 0,
        "is_used"       BOOLEAN      NOT NULL DEFAULT false,
        "expires_at"    TIMESTAMPTZ  NOT NULL,
        "created_at"    TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_otp_phone"
        ON "otp_verifications"("phone", "created_at" DESC)
    `);

    // ─── memory_tree_cache ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "memory_tree_cache" (
        "connection_id"    UUID PRIMARY KEY REFERENCES "diary_connections"("id"),
        "monthly_data"     JSONB        NOT NULL DEFAULT '[]',
        "total_entries"    INTEGER      NOT NULL DEFAULT 0,
        "active_months"    INTEGER      NOT NULL DEFAULT 0,
        "tree_health"      DECIMAL(3,2) NOT NULL DEFAULT 0.0,
        "last_computed_at" TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);

    // ─── feature_flags ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "feature_flags" (
        "key"                VARCHAR(100) PRIMARY KEY,
        "is_enabled"         BOOLEAN NOT NULL DEFAULT false,
        "rollout_percentage" INTEGER NOT NULL DEFAULT 0,
        "description"        TEXT,
        "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ─── audit_logs ───────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "audit_logs" (
        "id"            BIGSERIAL PRIMARY KEY,
        "user_id"       UUID REFERENCES "users"("id"),
        "action"        VARCHAR(100) NOT NULL,
        "resource_type" VARCHAR(50),
        "resource_id"   UUID,
        "metadata"      JSONB,
        "ip_address"    INET,
        "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_audit_user"
        ON "audit_logs"("user_id", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_audit_action"
        ON "audit_logs"("action", "created_at" DESC)
    `);

    // ─── rate_limit_counters ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "rate_limit_counters" (
        "key"          VARCHAR(200) PRIMARY KEY,
        "count"        INTEGER     NOT NULL DEFAULT 1,
        "window_start" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ─── Feature flag seed data ───────────────────────────────────────────────
    await queryRunner.query(`
      INSERT INTO "feature_flags" ("key", "is_enabled", "rollout_percentage", "description")
      VALUES
        ('video_entries',  false, 0,   'Video diary entries (Phase 2)'),
        ('occasion_ai',    false, 0,   'AI-generated occasion messages (Phase 2)'),
        ('memory_book',    false, 0,   'Physical Memory Book ordering (Phase 2)'),
        ('transcription',  true,  100, 'Voice transcription via OpenAI Whisper')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse order to respect foreign key constraints
    await queryRunner.query(`DROP TABLE IF EXISTS "rate_limit_counters" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "feature_flags" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "memory_tree_cache" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "otp_verifications" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "device_sessions" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "invites" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "memory_book_orders" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "occasion_ai_messages" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "occasions" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_preferences" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "notifications" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "streak_milestones" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "personal_journal_entries" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "flicker_events" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "diary_entries" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "diary_connections" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users" CASCADE`);
  }
}
