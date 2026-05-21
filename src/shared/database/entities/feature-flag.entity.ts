import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';

@Entity('feature_flags')
export class FeatureFlag {
  // PK is the flag key string e.g. 'video_entries', 'occasion_ai'
  @PrimaryColumn({ type: 'varchar', length: 100 })
  key: string;

  @Column({ type: 'boolean', default: false })
  is_enabled: boolean;

  // 0-100: gradual rollout percentage
  // deterministicRollout(userId, key) % 100 < rollout_percentage → enabled for that user
  @Column({ type: 'int', default: 0 })
  rollout_percentage: number;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
