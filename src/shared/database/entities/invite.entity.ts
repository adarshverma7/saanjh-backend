import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('invites')
@Index('idx_invites_code', ['invite_code'], { unique: true })
export class Invite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  inviter_id: string;

  @Column({ type: 'varchar', length: 12, unique: true })
  invite_code: string;

  @Column({ type: 'varchar', length: 15, nullable: true })
  invited_phone: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  invited_phone_hash: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  relationship_type: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  connection_name: string | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: string; // 'pending' | 'accepted' | 'expired' | 'cancelled'

  @Column({ type: 'uuid', nullable: true })
  accepted_by: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  accepted_at: Date | null;

  @Column({ type: 'int', default: 0 })
  click_count: number;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
