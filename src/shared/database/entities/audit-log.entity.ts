import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

// Append-only audit log. Never update or delete rows (except the 2-year retention cleanup job).
// Partition this table by month after 100,000 rows.
@Entity('audit_logs')
@Index('idx_audit_user', ['user_id', 'created_at'])
@Index('idx_audit_action', ['action', 'created_at'])
export class AuditLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  // Nullable — system actions may not have a user
  @Column({ type: 'uuid', nullable: true })
  user_id: string | null;

  @Column({ type: 'varchar', length: 100 })
  action: string;
  // Examples: 'entry.created' | 'entry.deleted' | 'connection.created'
  //           | 'account.delete_requested' | 'admin.user_suspended'

  @Column({ type: 'varchar', length: 50, nullable: true })
  resource_type: string | null;

  @Column({ type: 'uuid', nullable: true })
  resource_id: string | null;

  // Additional context — NEVER include transcription content or OTPs
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'inet', nullable: true })
  ip_address: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
