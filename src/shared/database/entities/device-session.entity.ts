import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Unique,
} from 'typeorm';

@Entity('device_sessions')
@Unique('uq_user_device', ['user_id', 'device_id'])
export class DeviceSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'varchar', length: 100 })
  device_id: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  device_type: string | null; // 'android' | 'ios'

  @Column({ type: 'text', nullable: true })
  fcm_token: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  app_version: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  os_version: string | null;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  // Hashed refresh token — never store plain text
  @Column({ type: 'varchar', length: 64, nullable: true })
  refresh_token_hash: string | null;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  last_used_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
