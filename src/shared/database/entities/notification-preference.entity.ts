import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';

@Entity('notification_preferences')
export class NotificationPreference {
  // PK is user_id — one row per user, 1-to-1 with users table
  @PrimaryColumn({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'boolean', default: true })
  new_entry: boolean;

  @Column({ type: 'boolean', default: true })
  flicker_received: boolean;

  @Column({ type: 'boolean', default: true })
  streak_reminder: boolean;

  @Column({ type: 'time', default: '20:00:00' })
  streak_reminder_time: string;

  @Column({ type: 'boolean', default: true })
  occasion_reminders: boolean;

  @Column({ type: 'boolean', default: true })
  morning_ritual: boolean;

  @Column({ type: 'time', default: '08:00:00' })
  morning_ritual_time: string;

  @Column({ type: 'time', default: '22:00:00' })
  quiet_hours_start: string;

  @Column({ type: 'time', default: '07:00:00' })
  quiet_hours_end: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
