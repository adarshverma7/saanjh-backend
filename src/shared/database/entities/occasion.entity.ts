import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('occasions')
export class Occasion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  connection_id: string;

  @Column({ type: 'uuid' })
  created_by: string;

  @Column({ type: 'varchar', length: 30 })
  occasion_type: string;
  // 'birthday' | 'anniversary' | 'diwali' | 'eid' | 'holi' | 'raksha_bandhan' | 'custom'

  @Column({ type: 'varchar', length: 100, nullable: true })
  occasion_name: string | null;

  @Column({ type: 'date' })
  occasion_date: string;

  @Column({ type: 'boolean', default: true })
  is_recurring: boolean;

  @Column({ type: 'int', default: 3 })
  remind_days_before: number;

  @Column({ type: 'int', nullable: true })
  last_reminded_year: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
