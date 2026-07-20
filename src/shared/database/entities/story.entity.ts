import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  PrimaryColumn,
} from 'typeorm';

@Entity('stories')
export class Story {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'text' })
  media_key: string;

  @Column({ type: 'varchar', length: 10 })
  media_type: string; // 'photo' | 'video' | 'audio'

  @Column({ type: 'text', nullable: true })
  caption: string | null;

  @Column({ type: 'smallint', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  upload_status: string; // 'pending' | 'completed' | 'failed'

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at: Date | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deleted_at: Date | null;
}

@Entity('story_views')
export class StoryView {
  @PrimaryColumn({ type: 'uuid' })
  story_id: string;

  @PrimaryColumn({ type: 'uuid' })
  viewer_id: string;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  viewed_at: Date;
}
