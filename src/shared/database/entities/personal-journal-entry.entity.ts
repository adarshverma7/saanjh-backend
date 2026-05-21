import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
} from 'typeorm';

// Completely isolated from diary_connections.
// Every query MUST include WHERE user_id = $currentUserId.
// No admin or partner visibility into this table.
@Entity('personal_journal_entries')
export class PersonalJournalEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  entry_type: string | null; // 'voice' | 'video' | 'text'

  @Column({ type: 'text', nullable: true })
  media_key: string | null;

  @Column({ type: 'text', nullable: true })
  text_content: string | null;

  @Column({ type: 'smallint', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  mood: string | null;

  @Column({ type: 'boolean', default: false })
  is_starred: boolean;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  recorded_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deleted_at: Date | null;
}
