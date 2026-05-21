import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { NotificationsService } from '../notifications/notifications.service';
import type { NotificationType } from '../notifications/notifications.service';

interface PushJobPayload {
  type: NotificationType;
  connectionId?: string;
  userIds?: string[];
  data: Record<string, unknown>;
}

interface FlickerSentEvent {
  connectionId: string;
  senderId: string;
  receiverId: string;
  flickerId: string;
  senderName: string;
}

interface MutualFlickerEvent {
  connectionId: string;
  senderId: string;
  receiverId: string;
  mutualAt: Date;
}

interface MilestoneEvent {
  connectionId: string;
  milestoneDay: number;
}

@Processor('notification')
@Injectable()
export class NotificationWorker {
  private readonly logger = new Logger(NotificationWorker.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly notificationsService: NotificationsService,
  ) {}

  // ── Bull queue path ────────────────────────────────────────────────────────

  @Process('push')
  async handlePushJob(job: Job<PushJobPayload>): Promise<void> {
    const { type, connectionId, userIds: directUserIds, data } = job.data;

    let userIds = directUserIds ?? [];

    if (!userIds.length && connectionId) {
      const rows = await this.db
        .query<{ user_a_id: string; user_b_id: string }[]>(
          `SELECT user_a_id, user_b_id FROM diary_connections WHERE id = $1`,
          [connectionId],
        )
        .catch(() => []);
      if (rows.length) {
        userIds = [rows[0].user_a_id, rows[0].user_b_id];
      }
    }

    if (!userIds.length) return;

    const vars = buildVars(data);
    for (const userId of userIds) {
      const { title, body } = this.notificationsService.renderTemplate(type, vars);
      await this.notificationsService
        .createNotification(userId, type, title, body, data)
        .catch((err: unknown) => this.logger.error(`Push job failed for user ${userId}`, err));
    }
  }

  // ── EventEmitter paths (real-time notifications) ───────────────────────────

  @OnEvent('flicker.sent')
  async onFlickerSent(payload: FlickerSentEvent): Promise<void> {
    const { connectionId, receiverId, senderName, flickerId } = payload;
    const { title, body } = this.notificationsService.renderTemplate('flicker_received', {
      partner_name: senderName,
    });

    await this.notificationsService
      .createNotification(receiverId, 'flicker_received', title, body, {
        connection_id: connectionId,
        flicker_id: flickerId,
      })
      .catch((err: unknown) => this.logger.error('onFlickerSent notification failed', err));
  }

  @OnEvent('flicker.mutual')
  async onFlickerMutual(payload: MutualFlickerEvent): Promise<void> {
    const { connectionId, senderId, receiverId } = payload;

    const users = await this.db
      .query<{ id: string; name: string | null }[]>(
        `SELECT id, name FROM users WHERE id = ANY($1::uuid[])`,
        [[senderId, receiverId]],
      )
      .catch(() => []);

    const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? 'Someone';

    const { title: titleA, body: bodyA } = this.notificationsService.renderTemplate(
      'mutual_flicker',
      { partner_name: nameOf(receiverId) },
    );
    const { title: titleB, body: bodyB } = this.notificationsService.renderTemplate(
      'mutual_flicker',
      { partner_name: nameOf(senderId) },
    );

    await Promise.allSettled([
      this.notificationsService.createNotification(
        senderId, 'mutual_flicker', titleA, bodyA, { connection_id: connectionId },
      ),
      this.notificationsService.createNotification(
        receiverId, 'mutual_flicker', titleB, bodyB, { connection_id: connectionId },
      ),
    ]);
  }

  @OnEvent('streak.milestone')
  async onMilestone(payload: MilestoneEvent): Promise<void> {
    const { connectionId, milestoneDay } = payload;

    const connRows = await this.db
      .query<{ user_a_id: string; user_b_id: string; name_for_a: string | null; name_for_b: string | null }[]>(
        `SELECT user_a_id, user_b_id, name_for_a, name_for_b
         FROM diary_connections WHERE id = $1`,
        [connectionId],
      )
      .catch(() => []);

    if (!connRows.length) return;

    const { user_a_id, user_b_id, name_for_a, name_for_b } = connRows[0];
    const streakStr = String(milestoneDay);

    const { title: titleA, body: bodyA } = this.notificationsService.renderTemplate('milestone', {
      streak_count: streakStr,
      partner_name: name_for_b ?? 'your partner',
    });
    const { title: titleB, body: bodyB } = this.notificationsService.renderTemplate('milestone', {
      streak_count: streakStr,
      partner_name: name_for_a ?? 'your partner',
    });

    await Promise.allSettled([
      this.notificationsService.createNotification(
        user_a_id, 'milestone', titleA, bodyA,
        { connection_id: connectionId, days: milestoneDay },
      ),
      this.notificationsService.createNotification(
        user_b_id, 'milestone', titleB, bodyB,
        { connection_id: connectionId, days: milestoneDay },
      ),
    ]);
  }
}

function buildVars(data: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    result[k] = String(v ?? '');
  }
  return result;
}
