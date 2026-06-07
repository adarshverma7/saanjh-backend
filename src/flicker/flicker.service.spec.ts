import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FlickerService } from './flicker.service';
import { EventsService } from './events.service';
import { TooManyRequestsException } from '../shared/exceptions/too-many-requests.exception';

const SENDER_ID    = 'aaaaaaaa-0000-0000-0000-000000000001';
const RECEIVER_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';
const CONN_ID      = 'cccccccc-0000-0000-0000-000000000003';
const FLICKER_ID   = 'ffffffff-0000-0000-0000-000000000004';

const CONN_ROW = { user_a_id: SENDER_ID, user_b_id: RECEIVER_ID };

function makeFlicker(overrides: Record<string, unknown> = {}) {
  return {
    id: FLICKER_ID,
    connection_id: CONN_ID,
    sender_id: SENDER_ID,
    receiver_id: RECEIVER_ID,
    sent_at: new Date(), // current time keeps window_closes_at (sent_at+5min) in the future
    is_mutual: false,
    mutual_at: null,
    mutual_window_secs: 300,
    ...overrides,
  };
}

describe('FlickerService', () => {
  let service: FlickerService;
  let mockDb: { query: jest.Mock };
  let mockEvents: { push: jest.Mock; broadcastToConnection: jest.Mock };
  let mockEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    mockDb     = { query: jest.fn() };
    mockEvents = { push: jest.fn(), broadcastToConnection: jest.fn() };
    mockEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlickerService,
        { provide: getDataSourceToken(), useValue: mockDb },
        { provide: EventsService, useValue: mockEvents },
        { provide: EventEmitter2, useValue: mockEmitter },
      ],
    }).compile();

    service = module.get<FlickerService>(FlickerService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── sendFlicker ────────────────────────────────────────────────────────────

  describe('sendFlicker', () => {
    function setupNonMutual() {
      mockDb.query
        .mockResolvedValueOnce([{ count: '1' }])       // rate limit
        .mockResolvedValueOnce([CONN_ROW])              // find connection
        .mockResolvedValueOnce([makeFlicker()])         // INSERT flicker RETURNING
        .mockResolvedValueOnce([])                      // mutual check → none found
        .mockResolvedValueOnce([])                      // partner flickered today → no
        .mockResolvedValueOnce([{ name: 'Adarsh' }]);  // sender name
    }

    function setupMutual() {
      mockDb.query
        .mockResolvedValueOnce([{ count: '1' }])                    // rate limit
        .mockResolvedValueOnce([CONN_ROW])                          // find connection
        .mockResolvedValueOnce([makeFlicker()])                     // INSERT flicker
        .mockResolvedValueOnce([{ id: 'partner-flicker-id' }])      // mutual found!
        .mockResolvedValueOnce([{ id: 'partner-flicker-id' }])      // partner flickered today → yes
        .mockResolvedValueOnce([]);                                 // UPDATE both mutual
    }

    it('returns flicker_id, is_mutual=false, and window_closes_at on non-mutual send', async () => {
      setupNonMutual();

      const result = await service.sendFlicker(SENDER_ID, CONN_ID);

      expect(result.flicker_id).toBe(FLICKER_ID);
      expect(result.is_mutual).toBe(false);
      expect(result.mutual_at).toBeNull();
      // window_closes_at should be 5 minutes after sent_at
      expect(result.window_closes_at.getTime()).toBeGreaterThan(Date.now());
    });

    it('pushes SSE to receiver (not sender) on non-mutual flicker', async () => {
      setupNonMutual();

      await service.sendFlicker(SENDER_ID, CONN_ID);

      expect(mockEvents.push).toHaveBeenCalledWith(
        RECEIVER_ID,
        CONN_ID,
        expect.objectContaining({ type: 'flicker_received' }),
      );
      // Sender must NOT receive a push (they triggered it)
      expect(mockEvents.push).not.toHaveBeenCalledWith(
        SENDER_ID,
        expect.anything(),
        expect.anything(),
      );
    });

    it('includes sender name in flicker_received SSE event', async () => {
      setupNonMutual();

      await service.sendFlicker(SENDER_ID, CONN_ID);

      const pushCall = mockEvents.push.mock.calls[0] as [
        string,
        string,
        { type: string; sender_name: string },
      ];
      expect(pushCall[2].sender_name).toBe('Adarsh');
    });

    it('emits flicker.sent event for notification worker', async () => {
      setupNonMutual();

      await service.sendFlicker(SENDER_ID, CONN_ID);

      expect(mockEmitter.emit).toHaveBeenCalledWith(
        'flicker.sent',
        expect.objectContaining({
          connectionId: CONN_ID,
          senderId: SENDER_ID,
          receiverId: RECEIVER_ID,
        }),
      );
    });

    it('returns is_mutual=true when receiver sent within the window', async () => {
      setupMutual();

      const result = await service.sendFlicker(SENDER_ID, CONN_ID);

      expect(result.is_mutual).toBe(true);
      expect(result.mutual_at).not.toBeNull();
    });

    it('broadcasts mutual_reveal SSE to BOTH users on mutual reveal', async () => {
      setupMutual();

      await service.sendFlicker(SENDER_ID, CONN_ID);

      expect(mockEvents.broadcastToConnection).toHaveBeenCalledWith(
        CONN_ID,
        SENDER_ID,
        RECEIVER_ID,
        expect.objectContaining({ type: 'mutual_reveal' }),
      );
    });

    it('emits flicker.mutual event on mutual reveal', async () => {
      setupMutual();

      await service.sendFlicker(SENDER_ID, CONN_ID);

      expect(mockEmitter.emit).toHaveBeenCalledWith(
        'flicker.mutual',
        expect.objectContaining({
          connectionId: CONN_ID,
          senderId: SENDER_ID,
          receiverId: RECEIVER_ID,
        }),
      );
    });

    it('throws FLICKER_RATE_LIMIT when 10+ flickers sent in an hour', async () => {
      mockDb.query.mockResolvedValueOnce([{ count: '11' }]); // over limit

      await expect(service.sendFlicker(SENDER_ID, CONN_ID)).rejects.toThrow(
        TooManyRequestsException,
      );
    });

    it('throws NotFoundException when connection not found', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ count: '1' }]) // rate limit
        .mockResolvedValueOnce([]);              // no connection

      await expect(service.sendFlicker(SENDER_ID, CONN_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('correctly identifies receiver when sender is user_b (not user_a)', async () => {
      // sender = RECEIVER_ID (user_b), so receiver should be SENDER_ID (user_a)
      mockDb.query
        .mockResolvedValueOnce([{ count: '1' }])
        .mockResolvedValueOnce([CONN_ROW])  // user_a = SENDER_ID, user_b = RECEIVER_ID
        .mockResolvedValueOnce([makeFlicker({ sender_id: RECEIVER_ID, receiver_id: SENDER_ID })])
        .mockResolvedValueOnce([])          // mutual check → none
        .mockResolvedValueOnce([])          // partner flickered today → no
        .mockResolvedValueOnce([{ name: 'Partner' }]);

      await service.sendFlicker(RECEIVER_ID, CONN_ID);

      // SSE should go to SENDER_ID (the non-sender in this call)
      expect(mockEvents.push).toHaveBeenCalledWith(
        SENDER_ID,
        CONN_ID,
        expect.objectContaining({ type: 'flicker_received' }),
      );
    });
  });

  // ── getFlickerStatus ────────────────────────────────────────────────────────

  describe('getFlickerStatus', () => {
    it('returns status with my/partner last flicker times', async () => {
      const sentAt = new Date('2026-05-20T10:00:00Z');
      mockDb.query
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce([{ sent_at: sentAt, is_mutual: false }])
        .mockResolvedValueOnce([]);  // no partner flicker

      const status = await service.getFlickerStatus(SENDER_ID, CONN_ID);

      expect(status.my_last_flicker_at?.toISOString()).toBe(sentAt.toISOString());
      expect(status.partner_last_flicker_at).toBeNull();
      expect(status.is_mutual).toBe(false);
      // sentAt is in the past (not today) so state is idle
      expect(status.current_state).toBe('idle');
    });

    it('returns is_mutual=true when latest flicker is mutual', async () => {
      mockDb.query
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce([{ sent_at: new Date(), is_mutual: true }])
        .mockResolvedValueOnce([{ sent_at: new Date() }]);

      const status = await service.getFlickerStatus(SENDER_ID, CONN_ID);
      expect(status.is_mutual).toBe(true);
      expect(status.current_state).toBe('mutual');
    });

    it('returns cached result within 30 seconds', async () => {
      const sentAt = new Date('2026-05-20T10:00:00Z');
      mockDb.query
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce([{ sent_at: sentAt, is_mutual: false }])
        .mockResolvedValueOnce([]);

      // First call — hits DB
      await service.getFlickerStatus(SENDER_ID, CONN_ID);

      // Second call — should use cache, NOT hit DB again
      await service.getFlickerStatus(SENDER_ID, CONN_ID);

      // DB query should have been called exactly 3 times (connection + my flicker + partner flicker)
      expect(mockDb.query).toHaveBeenCalledTimes(3);
    });
  });

  // ── onEntryCreated SSE bridge ──────────────────────────────────────────────

  describe('onEntryCreated (SSE bridge)', () => {
    it('pushes new_entry SSE event to partner only for text entries', async () => {
      mockDb.query.mockResolvedValueOnce([CONN_ROW]);

      await service.onEntryCreated({
        entryId: 'entry-001',
        connectionId: CONN_ID,
        authorId: SENDER_ID,
        entryType: 'text',
      });

      // Only partner should receive the SSE event
      expect(mockEvents.push).toHaveBeenCalledWith(
        RECEIVER_ID,
        CONN_ID,
        expect.objectContaining({ type: 'new_entry', entry_id: 'entry-001' }),
      );
      expect(mockEvents.push).not.toHaveBeenCalledWith(
        SENDER_ID,
        expect.anything(),
        expect.anything(),
      );
    });

    it('skips SSE for voice/video entries (handled by confirmUpload)', async () => {
      await service.onEntryCreated({
        entryId: 'e-voice',
        connectionId: CONN_ID,
        authorId: SENDER_ID,
        entryType: 'voice',
      });

      expect(mockEvents.push).not.toHaveBeenCalled();
    });

    it('silently handles DB errors without crashing', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('DB down'));

      await expect(
        service.onEntryCreated({
          entryId: 'e1', connectionId: CONN_ID, authorId: SENDER_ID, entryType: 'text',
        }),
      ).resolves.not.toThrow();
    });
  });
});
