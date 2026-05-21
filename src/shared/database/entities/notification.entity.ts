import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'varchar', length: 50 })
  type: string;
  // 'new_entry' | 'flicker_received' | 'mutual_flicker' | 'streak_reminder'
  // | 'milestone' | 'occasion' | 'memory_jar' | 'morning_ritual' | 'system'

  @Column({ type: 'text', nullable: true })
  title: string | null;

  @Column({ type: 'text', nullable: true })
  body: string | null;

  @Column({ type: 'jsonb', nullable: true })
  data: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: false })
  is_read: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  read_at: Date | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  push_status: string; // 'pending' | 'sent' | 'delivered' | 'failed' | 'skipped'

  @Column({ type: 'text', nullable: true })
  push_error: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
