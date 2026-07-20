import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { StorageService } from '../shared/storage/storage.service';
import { returningRows } from '../shared/database/query-utils';
import { EventsService } from '../flicker/events.service';
import { TooManyRequestsException } from '../shared/exceptions/too-many-requests.exception';
import type { RequestStoryUploadDto } from './dto/request-story-upload.dto';
import type { ConfirmStoryDto } from './dto/confirm-story.dto';

// Stories live for exactly 24 hours from the moment the upload is confirmed.
const STORY_LIFETIME_HOURS = 24;
// Cap on stories a user can post per rolling 24 h window.
const DAILY_STORY_LIMIT = 30;
const SIGNED_URL_TTL = 3600;

// ── Public response shapes (snake_case like the rest of the API) ─────────────

export interface StoryItem {
  id: string;
  user_id: string;
  media_type: string;
  media_url: string;
  caption: string | null;
  duration_seconds: number | null;
  created_at: Date;
  expires_at: Date;
  viewed: boolean;
  view_count: number;
}

export interface StoryGroup {
  user_id: string;
  name: string | null;
  avatar_url: string | null;
  is_self: boolean;
  all_viewed: boolean;
  stories: StoryItem[];
}

interface StoryRow {
  id: string;
  user_id: string;
  media_key: string;
  media_type: string;
  caption: string | null;
  duration_seconds: number | null;
  created_at: Date;
  expires_at: Date;
  name: string | null;
  avatar_key: string | null;
  viewed: boolean;
  view_count: string;
}

@Injectable()
export class StoriesService {
  private readonly logger = new Logger(StoriesService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly storage: StorageService,
    private readonly eventsService: EventsService,
  ) {}

  // ── Request upload (step 1) ────────────────────────────────────────────────
  // Pre-creates a pending story row and hands back a 15-min presigned PUT URL.

  async requestUpload(userId: string, dto: RequestStoryUploadDto) {
    const recent = await this.db.query<{ n: string }[]>(
      `SELECT COUNT(*) AS n FROM stories
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
         AND deleted_at IS NULL`,
      [userId],
    );
    if (Number(recent[0]?.n ?? 0) >= DAILY_STORY_LIMIT) {
      throw new TooManyRequestsException({
        error: 'STORY_RATE_LIMIT',
        message: 'Daily story limit reached. Try again tomorrow.',
      });
    }

    const storyId = randomUUID();
    const mediaKey = StorageService.storyKey(userId, storyId, dto.media_type);

    await this.db.query(
      `INSERT INTO stories (id, user_id, media_key, media_type, upload_status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [storyId, userId, mediaKey, dto.media_type],
    );

    const uploadUrl = await this.storage.getSignedUploadUrl(mediaKey);
    return {
      story_id: storyId,
      media_key: mediaKey,
      upload_url: uploadUrl,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  // ── Confirm (step 2) ───────────────────────────────────────────────────────
  // Verifies the blob landed in B2, activates the story for 24 h, and pushes
  // an SSE story_added signal to every connected partner who is online.

  async confirmUpload(userId: string, dto: ConfirmStoryDto): Promise<StoryItem> {
    const rows = await this.db.query<
      { id: string; user_id: string; media_key: string; media_type: string; upload_status: string }[]
    >(
      `SELECT id, user_id, media_key, media_type, upload_status
       FROM stories WHERE id = $1 AND deleted_at IS NULL`,
      [dto.story_id],
    );
    if (!rows.length) {
      throw new NotFoundException({ error: 'STORY_NOT_FOUND', message: 'Pending story not found.' });
    }
    const pending = rows[0];
    if (pending.user_id !== userId) {
      throw new ForbiddenException({ error: 'NOT_STORY_AUTHOR', message: 'Only the author can confirm a story.' });
    }
    if (pending.upload_status !== 'pending') {
      throw new BadRequestException({ error: 'ALREADY_CONFIRMED', message: 'Story has already been confirmed or failed.' });
    }

    // B2 eventual consistency — up to 3 retries
    let exists = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      exists = await this.storage.objectExists(pending.media_key);
      if (exists) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 600));
    }
    if (!exists) {
      await this.db.query(
        `UPDATE stories SET upload_status = 'failed' WHERE id = $1`,
        [dto.story_id],
      );
      throw new BadRequestException({
        error: 'MEDIA_NOT_UPLOADED',
        message: 'Story media not found in storage. Upload may have failed.',
      });
    }

    const caption = dto.caption?.trim();
    const updated = returningRows<StoryRow>(await this.db.query(
      `UPDATE stories
       SET upload_status = 'completed',
           caption = $1,
           duration_seconds = $2,
           expires_at = NOW() + INTERVAL '${STORY_LIFETIME_HOURS} hours'
       WHERE id = $3
       RETURNING id, user_id, media_key, media_type, caption, duration_seconds,
                 created_at, expires_at`,
      [caption?.length ? caption : null, dto.duration_seconds ?? null, dto.story_id],
    ));
    const story = updated[0];

    this.notifyPartners(userId, story.id).catch((err: unknown) => {
      this.logger.error('story_added SSE push failed', err);
    });

    return {
      id: story.id,
      user_id: story.user_id,
      media_type: story.media_type,
      media_url: await this.storage.getSignedDownloadUrl(pending.media_key, SIGNED_URL_TTL),
      caption: story.caption,
      duration_seconds: story.duration_seconds,
      created_at: story.created_at,
      expires_at: story.expires_at,
      viewed: true,
      view_count: 0,
    };
  }

  // ── List (grouped by user, Instagram-style) ────────────────────────────────
  // Own group first, then partners with unviewed stories, then fully-viewed.

  async listGrouped(userId: string): Promise<{ groups: StoryGroup[] }> {
    const rows = await this.db.query<StoryRow[]>(
      `WITH partners AS (
         SELECT DISTINCT CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END AS pid
         FROM diary_connections c
         WHERE (c.user_a_id = $1 OR c.user_b_id = $1) AND c.status = 'active'
       ),
       visible AS (
         SELECT pid FROM partners p
         WHERE NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = p.pid)
              OR (b.blocker_id = p.pid AND b.blocked_id = $1)
         )
         UNION SELECT $1
       )
       SELECT s.id, s.user_id, s.media_key, s.media_type, s.caption,
              s.duration_seconds, s.created_at, s.expires_at,
              u.name, u.avatar_key,
              EXISTS(SELECT 1 FROM story_views v
                     WHERE v.story_id = s.id AND v.viewer_id = $1) AS viewed,
              (SELECT COUNT(*) FROM story_views v WHERE v.story_id = s.id) AS view_count
       FROM stories s
       JOIN visible ON visible.pid = s.user_id
       JOIN users u ON u.id = s.user_id
       WHERE s.upload_status = 'completed'
         AND s.deleted_at IS NULL
         AND s.expires_at > NOW()
       ORDER BY s.created_at ASC`,
      [userId],
    );

    const byUser = new Map<string, { rows: StoryRow[] }>();
    for (const row of rows) {
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, { rows: [] });
      byUser.get(row.user_id)!.rows.push(row);
    }

    const groups: StoryGroup[] = [];
    for (const [uid, { rows: userRows }] of byUser) {
      const stories: StoryItem[] = await Promise.all(
        userRows.map(async (r) => ({
          id: r.id,
          user_id: r.user_id,
          media_type: r.media_type,
          media_url: await this.storage.getSignedDownloadUrl(r.media_key, SIGNED_URL_TTL),
          caption: r.caption,
          duration_seconds: r.duration_seconds,
          created_at: r.created_at,
          expires_at: r.expires_at,
          viewed: uid === userId ? true : r.viewed,
          view_count: Number(r.view_count),
        })),
      );
      const first = userRows[0];
      groups.push({
        user_id: uid,
        name: first.name,
        avatar_url: first.avatar_key
          ? await this.storage.getSignedDownloadUrl(first.avatar_key, SIGNED_URL_TTL)
          : null,
        is_self: uid === userId,
        all_viewed: stories.every((s) => s.viewed),
        stories,
      });
    }

    // Self first; then groups with unviewed stories (latest activity first);
    // fully-viewed groups trail in the same order.
    const latest = (g: StoryGroup) =>
      Math.max(...g.stories.map((s) => new Date(s.created_at).getTime()));
    groups.sort((a, b) => {
      if (a.is_self !== b.is_self) return a.is_self ? -1 : 1;
      if (a.all_viewed !== b.all_viewed) return a.all_viewed ? 1 : -1;
      return latest(b) - latest(a);
    });

    return { groups };
  }

  // ── Mark viewed ────────────────────────────────────────────────────────────

  async markViewed(userId: string, storyId: string): Promise<{ viewed: boolean }> {
    const story = await this.getVisibleStory(userId, storyId);
    if (story.user_id === userId) return { viewed: true }; // own story — no-op

    await this.db.query(
      `INSERT INTO story_views (story_id, viewer_id)
       VALUES ($1, $2)
       ON CONFLICT (story_id, viewer_id) DO NOTHING`,
      [storyId, userId],
    );
    return { viewed: true };
  }

  // ── Viewer list (author only) ──────────────────────────────────────────────

  async listViewers(userId: string, storyId: string) {
    const rows = await this.db.query<{ user_id: string }[]>(
      `SELECT user_id FROM stories WHERE id = $1 AND deleted_at IS NULL`,
      [storyId],
    );
    if (!rows.length) {
      throw new NotFoundException({ error: 'STORY_NOT_FOUND', message: 'Story not found.' });
    }
    if (rows[0].user_id !== userId) {
      throw new ForbiddenException({ error: 'NOT_STORY_AUTHOR', message: 'Only the author can see viewers.' });
    }

    const viewers = await this.db.query<
      { id: string; name: string | null; avatar_key: string | null; viewed_at: Date }[]
    >(
      `SELECT u.id, u.name, u.avatar_key, v.viewed_at
       FROM story_views v JOIN users u ON u.id = v.viewer_id
       WHERE v.story_id = $1
       ORDER BY v.viewed_at DESC`,
      [storyId],
    );

    return {
      viewers: await Promise.all(
        viewers.map(async (v) => ({
          user_id: v.id,
          name: v.name,
          avatar_url: v.avatar_key
            ? await this.storage.getSignedDownloadUrl(v.avatar_key, SIGNED_URL_TTL)
            : null,
          viewed_at: v.viewed_at,
        })),
      ),
    };
  }

  // ── Delete own story ───────────────────────────────────────────────────────

  async remove(userId: string, storyId: string): Promise<{ message: string }> {
    const rows = await this.db.query<{ user_id: string; media_key: string }[]>(
      `SELECT user_id, media_key FROM stories WHERE id = $1 AND deleted_at IS NULL`,
      [storyId],
    );
    if (!rows.length) {
      throw new NotFoundException({ error: 'STORY_NOT_FOUND', message: 'Story not found.' });
    }
    if (rows[0].user_id !== userId) {
      throw new ForbiddenException({ error: 'NOT_STORY_AUTHOR', message: 'Only the author can delete a story.' });
    }

    await this.db.query(`UPDATE stories SET deleted_at = NOW() WHERE id = $1`, [storyId]);
    // Best-effort blob cleanup — the row is already tombstoned either way
    this.storage.deleteObject(rows[0].media_key).catch(() => {});
    return { message: 'Story removed' };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Story must be live and posted by the viewer or one of their partners. */
  private async getVisibleStory(userId: string, storyId: string) {
    const rows = await this.db.query<{ id: string; user_id: string }[]>(
      `SELECT s.id, s.user_id FROM stories s
       WHERE s.id = $1 AND s.upload_status = 'completed'
         AND s.deleted_at IS NULL AND s.expires_at > NOW()
         AND (
           s.user_id = $2
           OR EXISTS (
             SELECT 1 FROM diary_connections c
             WHERE c.status = 'active'
               AND ((c.user_a_id = $2 AND c.user_b_id = s.user_id)
                 OR (c.user_b_id = $2 AND c.user_a_id = s.user_id))
           )
         )`,
      [storyId, userId],
    );
    if (!rows.length) {
      throw new NotFoundException({ error: 'STORY_NOT_FOUND', message: 'Story not found or expired.' });
    }
    return rows[0];
  }

  /** SSE story_added to every non-blocked partner's active streams. */
  private async notifyPartners(authorId: string, storyId: string): Promise<void> {
    const rows = await this.db.query<{ connection_id: string; partner_id: string }[]>(
      `SELECT c.id AS connection_id,
              CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END AS partner_id
       FROM diary_connections c
       WHERE (c.user_a_id = $1 OR c.user_b_id = $1) AND c.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = c.user_a_id AND b.blocked_id = c.user_b_id)
              OR (b.blocker_id = c.user_b_id AND b.blocked_id = c.user_a_id)
         )`,
      [authorId],
    );
    for (const { connection_id, partner_id } of rows) {
      this.eventsService.push(partner_id, connection_id, {
        type: 'story_added',
        story_id: storyId,
        user_id: authorId,
      });
    }
  }
}
