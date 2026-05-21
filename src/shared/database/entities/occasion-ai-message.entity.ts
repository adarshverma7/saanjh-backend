import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('occasion_ai_messages')
export class OccasionAiMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  connection_id: string | null;

  @Column({ type: 'uuid', nullable: true })
  occasion_id: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  occasion_type: string | null;

  @Column({ type: 'text', nullable: true })
  prompt_used: string | null;

  @Column({ type: 'text', nullable: true })
  generated_text: string | null;

  @Column({ type: 'varchar', length: 10, default: 'en' })
  language: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  model_used: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  used_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
