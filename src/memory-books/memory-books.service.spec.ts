import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { MemoryBooksService } from './memory-books.service';
import * as crypto from 'crypto';

const USER_A  = 'user-a-uuid';
const USER_B  = 'user-b-uuid';
const CONN_ID = 'conn-uuid-001';
const ORDER_ID = 'order-uuid-001';

const BASE_CONN = { user_a_id: USER_A, user_b_id: USER_B };

const BASE_ORDER = {
  id: ORDER_ID,
  connection_id: CONN_ID,
  ordered_by: USER_A,
  order_type: 'self',
  gift_recipient_name: null,
  gift_recipient_phone: null,
  date_from: '2026-01-01',
  date_to: '2026-05-01',
  entry_count: 10,
  amount_paise: 39900,
  currency: 'INR',
  razorpay_order_id: 'rzp_test_123',
  razorpay_payment_id: null,
  payment_status: 'pending',
  paid_at: null,
  pdf_key: null,
  print_status: 'not_started',
  shipping_address: { line1: '123 Main St', city: 'Mumbai', state: 'MH', pincode: '400001' },
  tracking_number: null,
  created_at: new Date('2026-05-20T10:00:00Z'),
  updated_at: new Date('2026-05-20T10:00:00Z'),
};

const PREVIEW_DTO = {
  connection_id: CONN_ID,
  date_from: '2026-01-01',
  date_to: '2026-05-01',
};

const CREATE_ORDER_DTO = {
  connection_id: CONN_ID,
  order_type: 'self' as const,
  date_from: '2026-01-01',
  date_to: '2026-05-01',
  shipping_address: { line1: '123 Main St', city: 'Mumbai', state: 'MH', pincode: '400001' },
};

describe('MemoryBooksService', () => {
  let service: MemoryBooksService;
  let mockDb: { query: jest.Mock };
  let mockConfig: { get: jest.Mock };
  let mockPdfQueue: { add: jest.Mock };

  beforeEach(async () => {
    mockDb      = { query: jest.fn() };
    mockConfig  = { get: jest.fn().mockReturnValue(undefined) }; // no Razorpay keys by default
    mockPdfQueue = { add: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryBooksService,
        { provide: getDataSourceToken(), useValue: mockDb },
        { provide: ConfigService, useValue: mockConfig },
        { provide: getQueueToken('pdf'), useValue: mockPdfQueue },
      ],
    }).compile();

    service = module.get<MemoryBooksService>(MemoryBooksService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── previewBook ─────────────────────────────────────────────────────────────

  describe('previewBook', () => {
    it('returns entry count, estimated pages, price and sample entries', async () => {
      mockDb.query
        .mockResolvedValueOnce([BASE_CONN])          // connection member check
        .mockResolvedValueOnce([{ count: '10' }])    // COUNT entries
        .mockResolvedValueOnce([                     // sample entries
          { id: 'e1', entry_type: 'voice', recorded_at: new Date(), duration_seconds: 30, transcription: 'Hello', mood: 'happy' },
        ]);

      const result = await service.previewBook(USER_A, PREVIEW_DTO);

      expect(result.entry_count).toBe(10);
      expect(result.estimated_pages).toBe(Math.ceil(10 * 1.2) + 5); // 17
      expect(result.price_paise).toBe(39900);
      expect(result.sample_entries).toHaveLength(1);
    });

    it('throws ForbiddenException when user is not a connection member', async () => {
      mockDb.query.mockResolvedValueOnce([BASE_CONN]); // conn found but user not member

      // user-c is not in BASE_CONN
      await expect(service.previewBook('user-c-uuid', PREVIEW_DTO))
        .rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException when connection not found', async () => {
      mockDb.query.mockResolvedValueOnce([]); // no connection

      await expect(service.previewBook(USER_A, PREVIEW_DTO))
        .rejects.toThrow(NotFoundException);
    });
  });

  // ── createOrder ─────────────────────────────────────────────────────────────

  describe('createOrder', () => {
    it('throws ForbiddenException when memory_book feature flag is disabled', async () => {
      mockDb.query.mockResolvedValueOnce([]); // feature flag not found

      await expect(service.createOrder(USER_A, CREATE_ORDER_DTO))
        .rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when no entries in date range', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ is_enabled: true, rollout_percentage: 100 }]) // flag
        .mockResolvedValueOnce([BASE_CONN])                                      // member check
        .mockResolvedValueOnce([{ count: '0' }]);                               // no entries

      await expect(service.createOrder(USER_A, CREATE_ORDER_DTO))
        .rejects.toThrow(BadRequestException);
    });

    it('creates order and returns razorpay_key when no Razorpay config (mock mode)', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ is_enabled: true, rollout_percentage: 100 }]) // flag
        .mockResolvedValueOnce([BASE_CONN])                                      // member check
        .mockResolvedValueOnce([{ count: '5' }])                                // entries
        .mockResolvedValueOnce([{ id: ORDER_ID }])                              // INSERT order
        .mockResolvedValueOnce([]);                                              // UPDATE razorpay_order_id

      const result = await service.createOrder(USER_A, CREATE_ORDER_DTO);

      expect(result.order_id).toBe(ORDER_ID);
      expect(result.amount_paise).toBe(39900);
      expect(result.currency).toBe('INR');
      expect(result.razorpay_order_id).toContain('rzp_mock_');
    });

    it('uses gift price when order_type is gift', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ is_enabled: true, rollout_percentage: 100 }])
        .mockResolvedValueOnce([BASE_CONN])
        .mockResolvedValueOnce([{ count: '3' }])
        .mockResolvedValueOnce([{ id: ORDER_ID }])
        .mockResolvedValueOnce([]);

      const result = await service.createOrder(USER_A, {
        ...CREATE_ORDER_DTO,
        order_type: 'gift',
        gift_recipient: { name: 'Priya', phone: '+919876543210' },
      });

      expect(result.amount_paise).toBe(49900);
    });

    it('respects rollout_percentage for deterministic flag check', async () => {
      // With rollout_percentage=0, no user should be in rollout
      mockDb.query
        .mockResolvedValueOnce([{ is_enabled: true, rollout_percentage: 0 }]);

      await expect(service.createOrder(USER_A, CREATE_ORDER_DTO))
        .rejects.toThrow(ForbiddenException);
    });
  });

  // ── verifyPayment ───────────────────────────────────────────────────────────

  describe('verifyPayment', () => {
    it('throws UnauthorizedException on invalid signature when key is set', async () => {
      mockConfig.get.mockImplementation((key: string) =>
        key === 'razorpay.keySecret' ? 'test-secret' : undefined,
      );

      await expect(service.verifyPayment(USER_A, ORDER_ID, {
        razorpay_order_id: 'rzp_ord_123',
        razorpay_payment_id: 'rzp_pay_456',
        razorpay_signature: 'invalid-sig',
      })).rejects.toThrow(UnauthorizedException);
    });

    it('accepts valid HMAC signature and marks order as paid', async () => {
      const rzpKeySecret = 'test-secret-key';
      const razorpay_order_id = 'rzp_ord_123';
      const razorpay_payment_id = 'rzp_pay_456';

      const body = `${razorpay_order_id}|${razorpay_payment_id}`;
      const razorpay_signature = crypto
        .createHmac('sha256', rzpKeySecret)
        .update(body)
        .digest('hex');

      mockConfig.get.mockImplementation((key: string) =>
        key === 'razorpay.keySecret' ? rzpKeySecret : undefined,
      );

      mockDb.query
        .mockResolvedValueOnce([BASE_ORDER])                                    // fetch order
        .mockResolvedValueOnce([{ ...BASE_ORDER, payment_status: 'paid' }]);   // UPDATE + RETURNING

      const result = await service.verifyPayment(USER_A, ORDER_ID, {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
      });

      expect(result.payment_status).toBe('paid');
      expect(mockPdfQueue.add).toHaveBeenCalledWith('generate_memory_book', { orderId: ORDER_ID });
    });

    it('is idempotent — returns existing paid order without re-queueing PDF', async () => {
      mockConfig.get.mockReturnValue(undefined); // no key → skip sig check

      mockDb.query.mockResolvedValueOnce([{ ...BASE_ORDER, payment_status: 'paid' }]);

      const result = await service.verifyPayment(USER_A, ORDER_ID, {
        razorpay_order_id: 'rzp_ord_123',
        razorpay_payment_id: 'rzp_pay_456',
        razorpay_signature: 'any',
      });

      expect(result.payment_status).toBe('paid');
      expect(mockPdfQueue.add).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when order not found', async () => {
      mockConfig.get.mockReturnValue(undefined);
      mockDb.query.mockResolvedValueOnce([]); // no order

      await expect(service.verifyPayment(USER_A, ORDER_ID, {
        razorpay_order_id: 'x', razorpay_payment_id: 'y', razorpay_signature: 'z',
      })).rejects.toThrow(NotFoundException);
    });
  });

  // ── getOrders ───────────────────────────────────────────────────────────────

  describe('getOrders', () => {
    it('returns all orders for user ordered by created_at DESC', async () => {
      mockDb.query.mockResolvedValueOnce([BASE_ORDER]);

      const result = await service.getOrders(USER_A);

      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('ORDER BY created_at DESC');
      expect(params[0]).toBe(USER_A);
      expect(result).toHaveLength(1);
    });
  });

  // ── getOrder ────────────────────────────────────────────────────────────────

  describe('getOrder', () => {
    it('returns order when found', async () => {
      mockDb.query.mockResolvedValueOnce([BASE_ORDER]);
      const result = await service.getOrder(USER_A, ORDER_ID);
      expect(result.id).toBe(ORDER_ID);
    });

    it('throws NotFoundException when order does not belong to user', async () => {
      mockDb.query.mockResolvedValueOnce([]);
      await expect(service.getOrder(USER_A, ORDER_ID)).rejects.toThrow(NotFoundException);
    });
  });
});
