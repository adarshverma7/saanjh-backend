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
