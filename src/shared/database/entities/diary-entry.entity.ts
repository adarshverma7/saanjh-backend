import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
} from 'typeorm';

@Entity('diary_entries')
export class DiaryEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  connection_id: string;

  @Column({ type: 'uuid' })
  author_id: string;

  @Column({ type: 'varchar', length: 10 })
  entry_type: string; // 'voice' | 'video'

  @Column({ type: 'text' })
  media_key: string;

  @Column({ type: 'smallint', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'int', nullable: true })
  file_size_bytes: number | null;

  @Column({ type: 'text', nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'text', nullable: true })
  transcription: string | null;

  @Column({ type: 'varchar', length: 20, default: 'completed' })
  upload_status: string; // 'pending' | 'completed' | 'failed'

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  transcription_status: string; // 'pending' | 'processing' | 'done' | 'failed' | 'skipped'

  @Column({ type: 'varchar', length: 20, nullable: true })
  mood: string | null; // 'happy' | 'calm' | 'thoughtful' | 'missing' | 'excited'

  @Column({ type: 'boolean', default: false })
  is_starred: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  starred_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  diary_expires_at: Date | null;

  @Column({ type: 'smallint', default: 0 })
  play_count: number;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  recorded_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deleted_at: Date | null;
}
