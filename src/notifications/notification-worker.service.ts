import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotificationsService } from './notifications.service';

/**
 * Handles real-time event-driven notifications (flicker sent, mutual reveal).
 * Cron-based notifications (streak reminders, occasions) live in NotificationCronService.
 */
@Injectable()
export class NotificationWorkerService {
  private readonly logger = new Logger(NotificationWorkerService.name);

  constructor(
    private readonly notificationsService: NotificationsService,
    @InjectDataSource() private readonly db: DataSource,
  ) {}

  @OnEvent('flicker.sent', { async: true })
  async onFlickerSent(payload: {
    connectionId: string;
    senderId: string;
    receiverId: string;
    flickerId: string;
    senderName: string;
  }): Promise<void> {
    try {
      const { title, body } = this.notificationsService.renderTemplate(
        'flicker_received',
        { partner_name: payload.senderName },
      );
      await this.notificationsService.createNotification(
        payload.receiverId,
        'flicker_received',
        title,
        body,
        {
          type: 'flicker',
          diary_id: payload.connectionId,
          flicker_id: payload.flickerId,
        },
      );
    } catch (err: unknown) {
      this.logger.error('Failed to send flicker_received notification', err);
    }
  }

  @OnEvent('entry.created', { async: true })
  async onEntryCreated(payload: {
    entryId: string;
    connectionId: string;
    authorId: string;
    entryType: string;
    durationSeconds: number | null;
  }): Promise<void> {
    try {
      const rows = await this.db.query<{
        user_a_id: string;
        user_b_id: string;
        author_name: string | null;
      }[]>(
        `SELECT dc.user_a_id, dc.user_b_id, u.name AS author_name
         FROM diary_connections dc
         JOIN users u ON u.id = $2
         WHERE dc.id = $1`,
        [payload.connectionId, payload.authorId],
      );

      if (!rows.length) return;

      const { user_a_id, user_b_id, author_name } = rows[0];
      const partnerId = user_a_id === payload.authorId ? user_b_id : user_a_id;
      const senderName = author_name ?? 'Someone';
      const duration = payload.durationSeconds ?? 0;

      let title: string;
      let body: string;
      if (payload.entryType === 'text') {
        title = `${senderName} sent you a message`;
        body = 'Tap to read';
      } else if (payload.entryType === 'video') {
        title = `${senderName} left you a video`;
        body = `${duration}s — tap to watch`;
      } else {
        title = `${senderName} left you a voice note`;
        body = `${duration}s — tap to listen`;
      }

      await this.notificationsService.createNotification(
        partnerId,
        'new_entry',
        title,
        body,
        {
          type: 'entry',
          diary_id: payload.connectionId,
          entry_id: payload.entryId,
          entry_type: payload.entryType,
        },
      );
    } catch (err: unknown) {
      this.logger.error('Failed to send new_entry notification', err);
    }
  }

  @OnEvent('flicker.mutual', { async: true })
  async onFlickerMutual(payload: {
    connectionId: string;
    senderId: string;
    receiverId: string;
    mutualAt: Date;
  }): Promise<void> {
    try {
      const rows = await this.db.query<{ id: string; name: string | null }[]>(
        `SELECT id, name FROM users WHERE id = ANY($1::uuid[])`,
        [[payload.senderId, payload.receiverId]],
      );

      const nameMap = new Map(rows.map((r) => [r.id, r.name ?? 'them']));
      const senderName   = nameMap.get(payload.senderId)   ?? 'them';
      const receiverName = nameMap.get(payload.receiverId) ?? 'them';

      const forSender   = this.notificationsService.renderTemplate('mutual_flicker', { partner_name: receiverName });
      const forReceiver = this.notificationsService.renderTemplate('mutual_flicker', { partner_name: senderName });

      await Promise.allSettled([
        this.notificationsService.createNotification(
          payload.senderId,
          'mutual_flicker',
          forSender.title,
          forSender.body,
          { type: 'flicker', diary_id: payload.connectionId },
        ),
        this.notificationsService.createNotification(
          payload.receiverId,
          'mutual_flicker',
          forReceiver.title,
          forReceiver.body,
          { type: 'flicker', diary_id: payload.connectionId },
        ),
      ]);
    } catch (err: unknown) {
      this.logger.error('Failed to send mutual_flicker notification', err);
    }
  }
}
