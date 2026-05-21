import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('flicker_events')
export class FlickerEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  connection_id: string;

  @Column({ type: 'uuid' })
  sender_id: string;

  @Column({ type: 'uuid' })
  receiver_id: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'sent_at' })
  sent_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  delivered_at: Date | null;

  @Column({ type: 'boolean', default: false })
  is_mutual: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  mutual_at: Date | null;

  // 5-minute window for mutual reveal
  @Column({ type: 'int', default: 300 })
  mutual_window_secs: number;
}
