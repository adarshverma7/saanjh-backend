import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Unique,
} from 'typeorm';

@Entity('streak_milestones')
@Unique('uq_milestone', ['connection_id', 'milestone_days'])
export class StreakMilestone {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  connection_id: string;

  @Column({ type: 'int' })
  milestone_days: number; // 7 | 30 | 60 | 100 | 200 | 365

  @CreateDateColumn({ type: 'timestamptz', name: 'achieved_at' })
  achieved_at: Date;

  @Column({ type: 'boolean', default: false })
  seen_by_a: boolean;

  @Column({ type: 'boolean', default: false })
  seen_by_b: boolean;
}
