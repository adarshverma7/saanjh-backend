import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('otp_verifications')
@Index('idx_otp_phone', ['phone', 'created_at'])
export class OtpVerification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 15 })
  phone: string;

  // SHA-256 hash of OTP — never store plain text
  @Column({ type: 'varchar', length: 64 })
  otp_hash: string;

  @Column({ type: 'varchar', length: 20, default: 'login' })
  purpose: string; // 'login' | 'delete_account'

  @Column({ type: 'smallint', default: 0 })
  attempt_count: number;

  @Column({ type: 'boolean', default: false })
  is_used: boolean;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
