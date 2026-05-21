import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { NotificationsService } from './notifications.service';

interface AtRiskRow {
  id: string;
  user_a_id: string;
  user_b_id: string;
  streak_count: number;
  name_for_a: string | null;
  name_for_b: string | null;
}

interface OccasionReminderRow {
  id: string;
  connection_id: string;
  occasion_name: string;
  occasion_date: string;
  remind_days_before: number;
  user_a_id: string;
  user_b_id: string;
  name_for_a: string | null;
  name_for_b: string | null;
}

@Injectable()
export class NotificationCronService {
  private readonly logger = new Logger(NotificationCronService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly notificationsService: NotificationsService,
  ) {}

  // 8 PM IST daily
  @Cron('0 14 * * *', { timeZone: 'Asia/Kolkata' })
  async sendStreakReminders(): Promise<void> {
    this.logger.log('Running streak reminder cron');

    const rows = await this.db.query<AtRiskRow[]>(
      `SELECT dc.id, dc.user_a_id, dc.user_b_id, dc.streak_count,
              dc.name_for_a, dc.name_for_b
       FROM diary_connections dc
       WHERE dc.status = 'active'
         AND dc.streak_count > 0
         AND (dc.streak_last_date IS NULL
              OR dc.streak_last_date < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date)
         AND NOT EXISTS (
           SELECT 1 FROM diary_entries de
           WHERE de.connection_id = dc.id
             AND DATE(de.recorded_at AT TIME ZONE 'Asia/Kolkata')
                 = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
             AND de.deleted_at IS NULL
         )`,
    ).catch((err: unknown) => {
      this.logger.error('Streak reminder query failed', err);
      return [] as AtRiskRow[];
    });

    this.logger.log(`Found ${rows.length} at-risk connections`);

    for (const row of rows) {
      const streakStr = String(row.streak_count);

      const partnerNameForA = row.name_for_b ?? 'your partner';
      const partnerNameForB = row.name_for_a ?? 'your partner';

      const { title: titleA, body: bodyA } = this.notificationsService.renderTemplate(
        'streak_reminder',
        { streak_count: streakStr, partner_name: partnerNameForA },
      );
      const { title: titleB, body: bodyB } = this.notificationsService.renderTemplate(
        'streak_reminder',
        { streak_count: streakStr, partner_name: partnerNameForB },
      );

      await Promise.allSettled([
        this.notificationsService.createNotification(
          row.user_a_id, 'streak_reminder', titleA, bodyA,
          { connection_id: row.id, streak_count: row.streak_count },
        ),
        this.notificationsService.createNotification(
          row.user_b_id, 'streak_reminder', titleB, bodyB,
          { connection_id: row.id, streak_count: row.streak_count },
        ),
      ]);
    }
  }

  // 7 AM IST daily
  @Cron('0 1 * * *', { timeZone: 'Asia/Kolkata' })
  async sendOccasionReminders(): Promise<void> {
    this.logger.log('Running occasion reminder cron');

    const rows = await this.db.query<OccasionReminderRow[]>(
      `SELECT o.id, o.connection_id, o.occasion_name, o.occasion_date,
              o.remind_days_before, dc.user_a_id, dc.user_b_id,
              dc.name_for_a, dc.name_for_b
       FROM occasions o
       JOIN diary_connections dc ON o.connection_id = dc.id
       WHERE EXTRACT(MONTH FROM o.occasion_date)
               = EXTRACT(MONTH FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')
                         + (o.remind_days_before || ' days')::INTERVAL)
         AND EXTRACT(DAY FROM o.occasion_date)
               = EXTRACT(DAY FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')
                         + (o.remind_days_before || ' days')::INTERVAL)
         AND (o.last_reminded_year IS NULL
              OR o.last_reminded_year < EXTRACT(YEAR FROM CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'))`,
    ).catch((err: unknown) => {
      this.logger.error('Occasion reminder query failed', err);
      return [] as OccasionReminderRow[];
    });

    this.logger.log(`Found ${rows.length} occasion reminders to send`);

    for (const row of rows) {
      const daysAway = String(row.remind_days_before);
      const partnerNameForA = row.name_for_b ?? 'your partner';
      const partnerNameForB = row.name_for_a ?? 'your partner';

      const { title: titleA, body: bodyA } = this.notificationsService.renderTemplate(
        'occasion',
        { occasion_name: row.occasion_name, days_away: daysAway, partner_name: partnerNameForA },
      );
      const { title: titleB, body: bodyB } = this.notificationsService.renderTemplate(
        'occasion',
        { occasion_name: row.occasion_name, days_away: daysAway, partner_name: partnerNameForB },
      );

      await Promise.allSettled([
        this.notificationsService.createNotification(
          row.user_a_id, 'occasion', titleA, bodyA,
          { connection_id: row.connection_id, occasion_id: row.id },
        ),
        this.notificationsService.createNotification(
          row.user_b_id, 'occasion', titleB, bodyB,
          { connection_id: row.connection_id, occasion_id: row.id },
        ),
      ]);

      // Mark last_reminded_year so we don't re-send this year
      await this.db.query(
        `UPDATE occasions
         SET last_reminded_year = EXTRACT(YEAR FROM CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')
         WHERE id = $1`,
        [row.id],
      ).catch((err: unknown) => this.logger.warn(`Failed to update last_reminded_year for ${row.id}`, err));
    }
  }
}
