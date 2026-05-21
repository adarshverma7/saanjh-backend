import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('memory_book_orders')
export class MemoryBookOrder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  connection_id: string;

  @Column({ type: 'uuid' })
  ordered_by: string;

  @Column({ type: 'varchar', length: 10, default: 'self' })
  order_type: string; // 'self' | 'gift'

  @Column({ type: 'varchar', length: 100, nullable: true })
  gift_recipient_name: string | null;

  @Column({ type: 'varchar', length: 15, nullable: true })
  gift_recipient_phone: string | null;

  @Column({ type: 'date' })
  date_from: string;

  @Column({ type: 'date' })
  date_to: string;

  @Column({ type: 'int', nullable: true })
  entry_count: number | null;

  // Store in paise: ₹399 = 39900
  @Column({ type: 'int' })
  amount_paise: number;

  @Column({ type: 'varchar', length: 3, default: 'INR' })
  currency: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  razorpay_order_id: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  razorpay_payment_id: string | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  payment_status: string; // 'pending' | 'paid' | 'failed' | 'refunded'

  @Column({ type: 'timestamptz', nullable: true })
  paid_at: Date | null;

  @Column({ type: 'text', nullable: true })
  pdf_key: string | null;

  @Column({ type: 'varchar', length: 20, default: 'not_started' })
  print_status: string;
  // 'not_started' | 'generating_pdf' | 'pdf_ready' | 'sent_to_printer' | 'shipped' | 'delivered'

  @Column({ type: 'jsonb', nullable: true })
  shipping_address: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  tracking_number: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
