import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { returningRows } from '../shared/database/query-utils';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import * as crypto from 'crypto';
import Razorpay from 'razorpay';
import type { CreateOrderDto } from './dto/create-order.dto';
import type { PreviewBookDto } from './dto/preview-book.dto';
import type { VerifyPaymentDto } from './dto/verify-payment.dto';

// ── Pricing ───────────────────────────────────────────────────────────────────
const PRICE_SELF_PAISE = 39900;
const PRICE_GIFT_PAISE = 49900;

// ── DB row shapes ─────────────────────────────────────────────────────────────

export interface MemoryBookOrder {
  id: string;
  connection_id: string;
  ordered_by: string;
  order_type: string;
  gift_recipient_name: string | null;
  gift_recipient_phone: string | null;
  date_from: string;
  date_to: string;
  entry_count: number | null;
  amount_paise: number;
  currency: string;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  payment_status: string;
  paid_at: Date | null;
  pdf_key: string | null;
  print_status: string;
  shipping_address: Record<string, unknown> | null;
  tracking_number: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface BookPreview {
  entry_count: number;
  estimated_pages: number;
  price_paise: number;
  sample_entries: SampleEntry[];
}

interface SampleEntry {
  id: string;
  entry_type: string;
  recorded_at: Date;
  duration_seconds: number | null;
  transcription: string | null;
  mood: string | null;
}

interface ConnMemberRow {
  user_a_id: string;
  user_b_id: string;
}

interface CountRow {
  count: string;
}

interface FeatureFlagRow {
  is_enabled: boolean;
  rollout_percentage: number;
}

export interface RazorpayOrderResult {
  order_id: string;
  razorpay_order_id: string;
  amount_paise: number;
  currency: string;
  razorpay_key: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class MemoryBooksService {
  private readonly logger = new Logger(MemoryBooksService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    @InjectQueue('pdf') private readonly pdfQueue: Queue,
  ) {}

  // ── Preview ────────────────────────────────────────────────────────────────

  async previewBook(userId: string, dto: PreviewBookDto): Promise<BookPreview> {
    await this.assertConnectionMember(userId, dto.connection_id);

    const countRows = await this.db.query<CountRow[]>(
      `SELECT COUNT(*)::text AS count
       FROM diary_entries
       WHERE connection_id = $1
         AND deleted_at IS NULL
         AND recorded_at::date BETWEEN $2 AND $3`,
      [dto.connection_id, dto.date_from, dto.date_to],
    );

    const entryCount = parseInt(countRows[0]?.count ?? '0', 10);
    const estimatedPages = Math.ceil(entryCount * 1.2) + 5;

    const sampleEntries = await this.db.query<SampleEntry[]>(
      `SELECT id, entry_type, recorded_at, duration_seconds, transcription, mood
       FROM diary_entries
       WHERE connection_id = $1
         AND deleted_at IS NULL
         AND recorded_at::date BETWEEN $2 AND $3
       ORDER BY recorded_at DESC
       LIMIT 3`,
      [dto.connection_id, dto.date_from, dto.date_to],
    );

    const pricePaise = PRICE_SELF_PAISE;

    return { entry_count: entryCount, estimated_pages: estimatedPages, price_paise: pricePaise, sample_entries: sampleEntries };
  }

  // ── Create Order ───────────────────────────────────────────────────────────

  async createOrder(userId: string, dto: CreateOrderDto): Promise<RazorpayOrderResult> {
    await this.assertFeatureEnabled(userId, 'memory_book');
    await this.assertConnectionMember(userId, dto.connection_id);

    const countRows = await this.db.query<CountRow[]>(
      `SELECT COUNT(*)::text AS count
       FROM diary_entries
       WHERE connection_id = $1
         AND deleted_at IS NULL
         AND recorded_at::date BETWEEN $2 AND $3`,
      [dto.connection_id, dto.date_from, dto.date_to],
    );

    const entryCount = parseInt(countRows[0]?.count ?? '0', 10);
    if (entryCount === 0) {
      throw new BadRequestException({
        error: 'NO_ENTRIES',
        message: 'No entries found in this date range',
      });
    }

    const pricePaise = dto.order_type === 'gift' ? PRICE_GIFT_PAISE : PRICE_SELF_PAISE;

    // Create internal order row first to get the orderId for Razorpay receipt
    const orderRows = await this.db.query<{ id: string }[]>(
      `INSERT INTO memory_book_orders
         (connection_id, ordered_by, order_type, date_from, date_to,
          entry_count, amount_paise, currency, payment_status,
          gift_recipient_name, gift_recipient_phone, shipping_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'INR', 'pending', $8, $9, $10)
       RETURNING id`,
      [
        dto.connection_id,
        userId,
        dto.order_type,
        dto.date_from,
        dto.date_to,
        entryCount,
        pricePaise,
        dto.gift_recipient?.name ?? null,
        dto.gift_recipient?.phone ?? null,
        JSON.stringify(dto.shipping_address),
      ],
    );

    const orderId = orderRows[0].id;

    // Create Razorpay order
    const rzpKeyId = this.config.get<string>('razorpay.keyId') ?? '';
    const rzpKeySecret = this.config.get<string>('razorpay.keySecret') ?? '';

    let razorpayOrderId = `rzp_mock_${orderId}`;

    if (rzpKeyId && rzpKeySecret) {
      try {
        const razorpay = new Razorpay({ key_id: rzpKeyId, key_secret: rzpKeySecret });
        const rzpOrder = await razorpay.orders.create({
          amount: pricePaise,
          currency: 'INR',
          receipt: `saanjh_${orderId}`,
          notes: { connection_id: dto.connection_id, user_id: userId },
        });
        razorpayOrderId = rzpOrder.id;
      } catch (err: unknown) {
        this.logger.error('Razorpay order creation failed', err);
        // Clean up the pending order row before throwing
        await this.db.query(`DELETE FROM memory_book_orders WHERE id = $1`, [orderId]).catch(() => {});
        throw new BadRequestException({ error: 'PAYMENT_GATEWAY_ERROR', message: 'Could not create payment order' });
      }
    }

    // Store Razorpay order ID
    await this.db.query(
      `UPDATE memory_book_orders SET razorpay_order_id = $1 WHERE id = $2`,
      [razorpayOrderId, orderId],
    );

    return {
      order_id: orderId,
      razorpay_order_id: razorpayOrderId,
      amount_paise: pricePaise,
      currency: 'INR',
      razorpay_key: rzpKeyId,
    };
  }

  // ── Verify Payment ─────────────────────────────────────────────────────────

  async verifyPayment(
    userId: string,
    orderId: string,
    dto: VerifyPaymentDto,
  ): Promise<MemoryBookOrder> {
    const rzpKeySecret = this.config.get<string>('razorpay.keySecret') ?? '';

    // Signature verification (critical — prevents fraud)
    if (rzpKeySecret) {
      const body = `${dto.razorpay_order_id}|${dto.razorpay_payment_id}`;
      const expectedSignature = crypto
        .createHmac('sha256', rzpKeySecret)
        .update(body)
        .digest('hex');

      if (expectedSignature !== dto.razorpay_signature) {
        throw new UnauthorizedException({
          error: 'PAYMENT_SIGNATURE_INVALID',
          message: 'Payment signature verification failed',
        });
      }
    }

    // Fetch and validate order
    const orderRows = await this.db.query<MemoryBookOrder[]>(
      `SELECT * FROM memory_book_orders WHERE id = $1 AND ordered_by = $2`,
      [orderId, userId],
    );

    if (!orderRows.length) {
      throw new NotFoundException({ error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    }

    const order = orderRows[0];
    if (order.payment_status === 'paid') {
      return order; // idempotent
    }

    // Mark as paid
    const updatedRows = returningRows<MemoryBookOrder>(await this.db.query(
      `UPDATE memory_book_orders
       SET payment_status = 'paid',
           paid_at = NOW(),
           razorpay_payment_id = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [dto.razorpay_payment_id, orderId],
    ));

    // Queue PDF generation
    await this.pdfQueue
      .add('generate_memory_book', { orderId })
      .catch((err: unknown) =>
        this.logger.warn(`PDF queue failed for order ${orderId} — will need manual trigger`, err),
      );

    return updatedRows[0];
  }

  // ── Get Orders ─────────────────────────────────────────────────────────────

  async getOrders(userId: string): Promise<MemoryBookOrder[]> {
    return this.db.query<MemoryBookOrder[]>(
      `SELECT * FROM memory_book_orders
       WHERE ordered_by = $1
       ORDER BY created_at DESC`,
      [userId],
    );
  }

  async getOrder(userId: string, orderId: string): Promise<MemoryBookOrder> {
    const rows = await this.db.query<MemoryBookOrder[]>(
      `SELECT * FROM memory_book_orders
       WHERE id = $1 AND ordered_by = $2`,
      [orderId, userId],
    );

    if (!rows.length) {
      throw new NotFoundException({ error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    }

    return rows[0];
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async assertConnectionMember(userId: string, connectionId: string): Promise<void> {
    const rows = await this.db.query<ConnMemberRow[]>(
      `SELECT user_a_id, user_b_id FROM diary_connections
       WHERE id = $1 AND status = 'active'`,
      [connectionId],
    );

    if (!rows.length) {
      throw new NotFoundException({ error: 'CONNECTION_NOT_FOUND', message: 'Connection not found' });
    }

    const { user_a_id, user_b_id } = rows[0];
    if (user_a_id !== userId && user_b_id !== userId) {
      throw new ForbiddenException({ error: 'NOT_CONNECTION_MEMBER', message: 'Access denied' });
    }
  }

  private async assertFeatureEnabled(userId: string, flagKey: string): Promise<void> {
    const rows = await this.db.query<FeatureFlagRow[]>(
      `SELECT is_enabled, rollout_percentage FROM feature_flags WHERE key = $1`,
      [flagKey],
    );

    if (!rows.length || !rows[0].is_enabled) {
      throw new ForbiddenException({ error: 'FEATURE_DISABLED', message: 'This feature is not available yet' });
    }

    const { rollout_percentage } = rows[0];
    if (rollout_percentage < 100) {
      // Deterministic rollout: SHA-256(userId + flagKey) % 100
      const hash = crypto.createHash('sha256').update(`${userId}${flagKey}`).digest('hex');
      const bucket = parseInt(hash.slice(0, 8), 16) % 100;
      if (bucket >= rollout_percentage) {
        throw new ForbiddenException({ error: 'FEATURE_NOT_ROLLED_OUT', message: 'Feature not yet available for your account' });
      }
    }
  }
}
