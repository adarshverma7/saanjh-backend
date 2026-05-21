import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';

// Simple sliding-window rate limiter backed by PostgreSQL (no Redis needed for MVP).
// Key format examples:
//   'otp:+91XXXXXXXXXX'          — OTP requests per phone
//   'otp_ip:1.2.3.4'             — OTP requests per IP
//   'flicker:connectionId:userId' — Flicker sends per connection per hour
//   'upload:connectionId:date'    — Media uploads per connection per day
@Entity('rate_limit_counters')
export class RateLimitCounter {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  key: string;

  @Column({ type: 'int', default: 1 })
  count: number;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  window_start: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
