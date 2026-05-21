import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Check,
  Unique,
  Index,
} from 'typeorm';

@Entity('diary_connections')
@Unique('uq_connection_pair', ['user_a_id', 'user_b_id'])
@Check('chk_pair_order', '"user_a_id" < "user_b_id"')
@Index('idx_conn_weather', ['diary_weather', 'last_entry_at'])
export class DiaryConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // INVARIANT: user_a_id < user_b_id (UUID string comparison)
  // Enforced by CHECK constraint + application logic before insert
  @Column({ type: 'uuid' })
  user_a_id: string;

  @Column({ type: 'uuid' })
  user_b_id: string;

  @Column({ type: 'varchar', length: 30, nullable: true })
  relationship_type: string | null;

  @Column({ type: 'uuid', nullable: true })
  initiated_by: string | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: string; // 'pending' | 'active' | 'paused' | 'ended'

  @Column({ type: 'varchar', length: 100, nullable: true })
  name_for_a: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  name_for_b: string | null;

  @Column({ type: 'int', default: 0 })
  streak_count: number;

  @Column({ type: 'int', default: 0 })
  longest_streak: number;

  @Column({ type: 'date', nullable: true })
  streak_last_date: string | null;

  @Column({ type: 'date', nullable: true })
  streak_started_at: string | null;

  @Column({ type: 'varchar', length: 20, default: 'sunny' })
  diary_weather: string; // 'sunny' | 'partly_cloudy' | 'cloudy' | 'dormant'

  @Column({ type: 'timestamptz', nullable: true })
  last_entry_at: Date | null;

  @Column({ type: 'int', default: 0 })
  total_entry_count: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
