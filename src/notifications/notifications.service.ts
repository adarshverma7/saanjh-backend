import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { UpdateNotificationPreferencesDto } from './dto/notification-preferences.dto';
import type { DeviceTokenDto } from './dto/device-token.dto';

// ── Notification type key ────────────────────────────────────────────────────
export type NotificationType =
  | 'new_entry'
  | 'flicker_received'
  | 'mutual_flicker'
  | 'streak_reminder'
  | 'milestone'
  | 'occasion';

// ── DB row shapes ─────────────────────────────────────────────────────────────

// Matches actual notification_preferences table columns
export interface PreferenceRow {
  new_entry: boolean;
  flicker_received: boolean;
  streak_reminder: boolean;
  occasion_reminders: boolean;
  morning_ritual: boolean;
  quiet_hours_start: string;  // 'HH:MM:SS' from PostgreSQL TIME
  quiet_hours_end: string;
}

// Maps NotificationType → preference column name
const PREF_COLUMN: Record<NotificationType, keyof PreferenceRow> = {
  new_entry:       'new_entry',
  flicker_received: 'flicker_received',
  mutual_flicker:  'flicker_received',  // shares flicker_received pref
  streak_reminder: 'streak_reminder',
  milestone:       'streak_reminder',   // shares streak_reminder pref
  occasion:        'occasion_reminders',
};

export interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  is_read: boolean;
  read_at: Date | null;
  push_status: string;
  created_at: Date;
}

interface TokenRow {
  id: string;
  user_id: string;
  fcm_token: string;
}

// ── Notification templates ───────────────────────────────────────────────────
const TEMPLATES: Record<NotificationType, { title: string; body: string }> = {
  new_entry: {
    title: '{{partner_name}} left you a voice note',
    body: '{{duration}}s — tap to listen',
  },
  flicker_received: {
    title: '{{partner_name}} is thinking of you',
    body: 'They sent you a Flicker',
  },
  mutual_flicker: {
    title: 'You and {{partner_name}} flickered each other ♥',
    body: 'A little moment, shared.',
  },
  streak_reminder: {
    title: 'Your streak is at risk',
    body: "{{streak_count}} days with {{partner_name}} — don't break it",
  },
  milestone: {
    title: '{{streak_count}} days together',
    body: 'You and {{partner_name}} hit a milestone',
  },
  occasion: {
    title: '{{occasion_name}} is in {{days_away}} days',
    body: 'Record something special for {{partner_name}}',
  },
};

// ── Service ───────────────────────────────────────────────────────────────────
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  async createNotification(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    // Step 1: Insert in-app notification (always)
    const rows = await this.db.query<{ id: string }[]>(
      `INSERT INTO notifications (user_id, type, title, body, data)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, type, title, body, JSON.stringify(data)],
    ).catch((err: unknown) => {
      this.logger.error('Failed to insert notification', err);
      return [] as { id: string }[];
    });

    const notificationId = rows[0]?.id;

    // Step 2: Check preferences + quiet hours
    const allowed = await this.isPushAllowed(userId, type);
    if (!allowed) {
      if (notificationId) {
        await this.db.query(
          `UPDATE notifications SET push_status = 'skipped' WHERE id = $1`,
          [notificationId],
        ).catch(() => {});
      }
      return;
    }

    // Step 3: Send push
    const pushOk = await this.sendPush([userId], title, body, data);

    // Step 4: Update push_status
    if (notificationId) {
      const status = pushOk ? 'sent' : 'failed';
      await this.db.query(
        `UPDATE notifications SET push_status = $1 WHERE id = $2`,
        [status, notificationId],
      ).catch(() => {});
    }
  }

  processTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
  }

  renderTemplate(
    type: NotificationType,
    vars: Record<string, string>,
  ): { title: string; body: string } {
    const tpl = TEMPLATES[type];
    return {
      title: this.processTemplate(tpl.title, vars),
      body: this.processTemplate(tpl.body, vars),
    };
  }

  async sendPush(
    userIds: string[],
    title: string,
    body: string,
    data: Record<string, unknown> = {},
  ): Promise<boolean> {
    const appId = this.config.get<string>('oneSignal.appId');
    const apiKey = this.config.get<string>('oneSignal.apiKey');

    if (!appId || !apiKey) {
      this.logger.debug(`OneSignal not configured — skipping push`);
      return false;
    }

    const tokenRows = await this.db.query<TokenRow[]>(
      `SELECT id, user_id, fcm_token FROM device_sessions
       WHERE user_id = ANY($1::uuid[])
         AND is_active = true
         AND fcm_token IS NOT NULL`,
      [userIds],
    ).catch(() => [] as TokenRow[]);

    if (!tokenRows.length) return false;

    try {
      const response = await axios.post<{ errors?: { invalid_player_ids?: string[] } }>(
        'https://onesignal.com/api/v1/notifications',
        {
          app_id: appId,
          include_player_ids: tokenRows.map((r) => r.fcm_token),
          headings: { en: title },
          contents: { en: body },
          data,
        },
        {
          headers: {
            Authorization: `Basic ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 8_000,
        },
      );

      // Deactivate invalid tokens returned by OneSignal
      const invalidIds = response.data.errors?.invalid_player_ids ?? [];
      if (invalidIds.length) {
        const invalidTokenSet = new Set(invalidIds);
        const toDeactivate = tokenRows
          .filter((r) => invalidTokenSet.has(r.fcm_token))
          .map((r) => r.id);

        if (toDeactivate.length) {
          await this.db.query(
            `UPDATE device_sessions SET is_active = false WHERE id = ANY($1::uuid[])`,
            [toDeactivate],
          ).catch(() => {});
        }
      }

      return true;
    } catch (err: unknown) {
      this.logger.error('OneSignal push failed', err);
      return false;
    }
  }

  async getNotifications(
    userId: string,
    filter: 'all' | 'unread' = 'all',
    limit = 20,
    cursor?: string,
  ): Promise<{ items: NotificationRow[]; next_cursor: string | null }> {
    let cursorSql = '';
    const params: unknown[] = [userId, limit + 1];

    if (cursor) {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const [ts, id] = decoded.split('|');
      params.push(ts, id);
      cursorSql = `AND (n.created_at < $3 OR (n.created_at = $3 AND n.id < $4))`;
    }

    const unreadSql = filter === 'unread' ? `AND n.is_read = false` : '';

    const rows = await this.db.query<NotificationRow[]>(
      `SELECT id, user_id, type, title, body, data, is_read, read_at, push_status, created_at
       FROM notifications n
       WHERE n.user_id = $1
         ${unreadSql}
         ${cursorSql}
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT $2`,
      params,
    );

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url')
        : null;

    return { items, next_cursor: nextCursor };
  }

  async markAsRead(userId: string, ids: string[]): Promise<void> {
    await this.db.query(
      `UPDATE notifications
       SET is_read = true, read_at = NOW()
       WHERE id = ANY($1::uuid[]) AND user_id = $2 AND is_read = false`,
      [ids, userId],
    );
  }

  async getPreferences(userId: string): Promise<PreferenceRow> {
    const rows = await this.db.query<PreferenceRow[]>(
      `SELECT new_entry, flicker_received, streak_reminder,
              occasion_reminders, morning_ritual,
              quiet_hours_start, quiet_hours_end
       FROM notification_preferences
       WHERE user_id = $1`,
      [userId],
    );

    if (rows.length) return rows[0];

    // Defaults when no row exists yet
    return {
      new_entry: true,
      flicker_received: true,
      streak_reminder: true,
      occasion_reminders: true,
      morning_ritual: true,
      quiet_hours_start: '22:00:00',
      quiet_hours_end: '08:00:00',
    };
  }

  async updatePreferences(
    userId: string,
    dto: UpdateNotificationPreferencesDto,
  ): Promise<PreferenceRow> {
    const setClauses: string[] = [];
    const params: unknown[] = [userId];
    let idx = 2;

    const fields: (keyof UpdateNotificationPreferencesDto)[] = [
      'new_entry', 'flicker_received', 'streak_reminder',
      'occasion_reminders', 'morning_ritual',
      'quiet_hours_start', 'quiet_hours_end',
    ];

    for (const field of fields) {
      if (dto[field] !== undefined) {
        setClauses.push(`${field} = $${idx++}`);
        params.push(dto[field]);
      }
    }

    if (!setClauses.length) return this.getPreferences(userId);

    await this.db.query(
      `INSERT INTO notification_preferences (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );

    await this.db.query(
      `UPDATE notification_preferences
       SET ${setClauses.join(', ')}, updated_at = NOW()
       WHERE user_id = $1`,
      params,
    );

    return this.getPreferences(userId);
  }

  async registerDeviceToken(userId: string, dto: DeviceTokenDto): Promise<void> {
    await this.db.query(
      `INSERT INTO device_sessions
         (user_id, device_id, fcm_token, app_version, platform, last_used_at, is_active)
       VALUES ($1, $2, $3, $4, $5, NOW(), true)
       ON CONFLICT (user_id, device_id) DO UPDATE SET
         fcm_token    = EXCLUDED.fcm_token,
         app_version  = EXCLUDED.app_version,
         platform     = COALESCE(EXCLUDED.platform, device_sessions.platform),
         last_used_at = NOW(),
         is_active    = true`,
      [userId, dto.device_id, dto.fcm_token, dto.app_version ?? null, dto.platform ?? null],
    );
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async isPushAllowed(userId: string, type: NotificationType): Promise<boolean> {
    const prefs = await this.getPreferences(userId);
    const col = PREF_COLUMN[type];

    // Boolean preference check
    if (!prefs[col]) return false;

    // Quiet hours check (PostgreSQL returns TIME as 'HH:MM:SS')
    const nowIST = currentISTTime();
    const start = prefs.quiet_hours_start.slice(0, 5); // trim seconds → 'HH:MM'
    const end   = prefs.quiet_hours_end.slice(0, 5);

    if (isInQuietHours(nowIST, start, end)) return false;

    return true;
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────

function currentISTTime(): string {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(Date.now() + IST_OFFSET_MS);
  const hh = istDate.getUTCHours().toString().padStart(2, '0');
  const mm = istDate.getUTCMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Returns true if `now` falls within [start, end] quiet window.
 * Handles overnight windows (e.g. 22:00 → 08:00).
 */
export function isInQuietHours(now: string, start: string, end: string): boolean {
  const nowMin = timeToMinutes(now);
  const startMin = timeToMinutes(start);
  const endMin = timeToMinutes(end);

  if (startMin <= endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // Overnight window
  return nowMin >= startMin || nowMin < endMin;
}
