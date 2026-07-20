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

/** A row as returned by the grouped per-sender state query. */
function lastFlicker(senderId: string, at: Date = new Date()) {
  return { sender_id: senderId, last_at: at };
}

describe('FlickerService', () => {
  let service: FlickerService;
  let mockDb: { query: jest.Mock; createQueryRunner: jest.Mock };
  let mockRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    query: jest.Mock;
  };
  let mockEvents: { push: jest.Mock; broadcastToConnection: jest.Mock };
  let mockEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    mockRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
    };
    mockDb = {
      query: jest.fn(),
      createQueryRunner: jest.fn().mockReturnValue(mockRunner),
    };
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
    /** Nobody has flickered yet today — this send leaves the pair at 'i_sent'. */
    function setupNonMutual(senderId = SENDER_ID) {
      mockDb.query
        .mockResolvedValueOnce([{ count: '1' }])        // rate limit
        .mockResolvedValueOnce([{ name: 'Adarsh' }]);   // sender name (post-commit)
      mockRunner.query
        .mockResolvedValueOnce([CONN_ROW])              // SELECT connection FOR UPDATE
        .mockResolvedValueOnce([])                      // state before: neither sent
        .mockResolvedValueOnce([makeFlicker()])         // INSERT flicker RETURNING
        .mockResolvedValueOnce([lastFlicker(senderId)]); // state after: only sender
    }

    /** Partner already flickered today — this send flips the pair to mutual. */
    function setupMutual() {
      mockDb.query
        .mockResolvedValueOnce([{ count: '1' }])
        .mockResolvedValueOnce([{ name: 'Adarsh' }]);
      mockRunner.query
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce([lastFlicker(RECEIVER_ID)]) // before: partner only
        .mockResolvedValueOnce([makeFlicker()])            // INSERT
        .mockResolvedValueOnce([                           // after: both → mutual
          lastFlicker(RECEIVER_ID),
          lastFlicker(SENDER_ID),
        ])
        .mockResolvedValueOnce([]);                        // UPDATE mark mutual
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
      // The sender still gets the canonical flicker_state push (both sides must
      // stay in sync), but never a flicker_received for their own action.
      expect(mockEvents.push).not.toHaveBeenCalledWith(
        SENDER_ID,
        CONN_ID,
        expect.objectContaining({ type: 'flicker_received' }),
      );
    });

    it('includes sender name in flicker_received SSE event', async () => {
      setupNonMutual();

      await service.sendFlicker(SENDER_ID, CONN_ID);

      const received = mockEvents.push.mock.calls.find(
        (c) => (c[2] as { type: string }).type === 'flicker_received',
      )?.[2] as { sender_name: string };
      expect(received.sender_name).toBe('Adarsh');
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
      mockDb.query.mockResolvedValueOnce([{ count: '1' }]); // rate limit
      mockRunner.query.mockResolvedValueOnce([]);           // no connection

      await expect(service.sendFlicker(SENDER_ID, CONN_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockRunner.release).toHaveBeenCalled();
    });

    it('correctly identifies receiver when sender is user_b (not user_a)', async () => {
      // sender = RECEIVER_ID (user_b), so receiver should be SENDER_ID (user_a)
      setupNonMutual(RECEIVER_ID);

      await service.sendFlicker(RECEIVER_ID, CONN_ID);

      // SSE should go to SENDER_ID (the non-sender in this call)
      expect(mockEvents.push).toHaveBeenCalledWith(
        SENDER_ID,
        CONN_ID,
        expect.objectContaining({ type: 'flicker_received' }),
      );
    });

    // ── Cross-device consistency guarantees ──────────────────────────────────

    it('pushes canonical flicker_state to BOTH users on every send', async () => {
      setupNonMutual();

      await service.sendFlicker(SENDER_ID, CONN_ID);

      const statePushes = mockEvents.push.mock.calls.filter(
        (c) => (c[2] as { type: string }).type === 'flicker_state',
      );
      expect(statePushes.map((c) => c[0]).sort()).toEqual(
        [SENDER_ID, RECEIVER_ID].sort(),
      );
    });

    it('gives each user their own perspective of the same state', async () => {
      setupNonMutual();

      await service.sendFlicker(SENDER_ID, CONN_ID);

      const byUser = (id: string) =>
        mockEvents.push.mock.calls.find(
          (c) => c[0] === id && (c[2] as { type: string }).type === 'flicker_state',
        )?.[2] as { current_state: string; is_mutual: boolean };

      // Same underlying truth, mirrored per side — never contradictory.
      expect(byUser(SENDER_ID).current_state).toBe('i_sent');
      expect(byUser(RECEIVER_ID).current_state).toBe('they_sent');
      expect(byUser(SENDER_ID).is_mutual).toBe(false);
      expect(byUser(RECEIVER_ID).is_mutual).toBe(false);
    });

    it('reports mutual to BOTH users simultaneously when the pair completes', async () => {
      setupMutual();

      await service.sendFlicker(SENDER_ID, CONN_ID);

      for (const id of [SENDER_ID, RECEIVER_ID]) {
        const payload = mockEvents.push.mock.calls.find(
          (c) => c[0] === id && (c[2] as { type: string }).type === 'flicker_state',
        )?.[2] as { current_state: string; is_mutual: boolean };
        expect(payload.current_state).toBe('mutual');
        expect(payload.is_mutual).toBe(true);
      }
    });

    it('serialises concurrent sends with a row lock on the connection', async () => {
      setupNonMutual();

      await service.sendFlicker(SENDER_ID, CONN_ID);

      // The connection row must be read FOR UPDATE inside the transaction so a
      // simultaneous flicker from the partner cannot miss this one.
      const lockQuery = mockRunner.query.mock.calls[0][0] as string;
      expect(lockQuery).toContain('FOR UPDATE');
      expect(mockRunner.startTransaction).toHaveBeenCalled();
      expect(mockRunner.commitTransaction).toHaveBeenCalled();
    });

    it('marks mutual even when the two flickers are hours apart', async () => {
      // Partner flickered this morning; this send happens in the afternoon —
      // far outside the 5-minute reveal window that used to gate mutual.
      const morning = new Date(Date.now() - 6 * 3600 * 1000);
      mockDb.query
        .mockResolvedValueOnce([{ count: '1' }])
        .mockResolvedValueOnce([{ name: 'Adarsh' }]);
      mockRunner.query
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce([lastFlicker(RECEIVER_ID, morning)])
        .mockResolvedValueOnce([makeFlicker()])
        .mockResolvedValueOnce([
          lastFlicker(RECEIVER_ID, morning),
          lastFlicker(SENDER_ID),
        ])
        .mockResolvedValueOnce([]);

      const result = await service.sendFlicker(SENDER_ID, CONN_ID);

      expect(result.is_mutual).toBe(true);
      expect(mockEvents.broadcastToConnection).toHaveBeenCalledWith(
        CONN_ID,
        SENDER_ID,
        RECEIVER_ID,
        expect.objectContaining({ type: 'mutual_reveal' }),
      );
    });
  });

  // ── getFlickerStatus ────────────────────────────────────────────────────────

  describe('getFlickerStatus', () => {
    it('returns status with my/partner last flicker times', async () => {
      const sentAt = new Date();
      mockDb.query
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce([lastFlicker(SENDER_ID, sentAt)]);

      const status = await service.getFlickerStatus(SENDER_ID, CONN_ID);

      expect(status.my_last_flicker_at?.toISOString()).toBe(sentAt.toISOString());
      expect(status.partner_last_flicker_at).toBeNull();
      expect(status.is_mutual).toBe(false);
      expect(status.current_state).toBe('i_sent');
    });

    it('returns idle when neither side flickered today', async () => {
      mockDb.query
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce([]); // the day-scoped query returns nothing

      const status = await service.getFlickerStatus(SENDER_ID, CONN_ID);

      expect(status.my_last_flicker_at).toBeNull();
      expect(status.current_state).toBe('idle');
    });

    it('returns is_mutual=true when both sides flickered today', async () => {
      mockDb.query
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce([
          lastFlicker(SENDER_ID),
          lastFlicker(RECEIVER_ID),
        ]);

      const status = await service.getFlickerStatus(SENDER_ID, CONN_ID);
      expect(status.is_mutual).toBe(true);
      expect(status.current_state).toBe('mutual');
    });

    it('gives both users the same mutual verdict from one computation', async () => {
      const bothSent = [lastFlicker(SENDER_ID), lastFlicker(RECEIVER_ID)];
      mockDb.query
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce(bothSent)
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce(bothSent);

      const mine = await service.getFlickerStatus(SENDER_ID, CONN_ID);
      const theirs = await service.getFlickerStatus(RECEIVER_ID, CONN_ID);

      expect(mine.current_state).toBe('mutual');
      expect(theirs.current_state).toBe('mutual');
      expect(mine.is_mutual).toBe(theirs.is_mutual);
    });

    it('returns cached result within 30 seconds', async () => {
      mockDb.query
        .mockResolvedValueOnce([CONN_ROW])
        .mockResolvedValueOnce([lastFlicker(SENDER_ID)]);

      // First call — hits DB
      await service.getFlickerStatus(SENDER_ID, CONN_ID);

      // Second call — should use cache, NOT hit DB again
      await service.getFlickerStatus(SENDER_ID, CONN_ID);

      // Exactly two queries: connection lookup + day-scoped state read.
      expect(mockDb.query).toHaveBeenCalledTimes(2);
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
