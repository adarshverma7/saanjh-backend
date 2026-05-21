import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { ConnectionsService } from './connections.service';
import { StorageService } from '../shared/storage/storage.service';
import { TooManyRequestsException } from '../shared/exceptions/too-many-requests.exception';

const INVITER_ID   = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACCEPTOR_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';
const CONN_ID      = 'cccccccc-0000-0000-0000-000000000003';
const INVITE_CODE  = 'SAANJ123';

function makeInvite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invite-uuid',
    invite_code: INVITE_CODE,
    inviter_id: INVITER_ID,
    relationship_type: 'parent_child',
    connection_name: 'Maa',
    status: 'pending',
    expires_at: new Date(Date.now() + 86400_000),
    inviter_name: 'Adarsh',
    ...overrides,
  };
}

describe('ConnectionsService', () => {
  let service: ConnectionsService;
  let mockDb: { query: jest.Mock };
  let mockStorage: Partial<StorageService>;

  beforeEach(async () => {
    mockDb = { query: jest.fn() };
    mockStorage = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://cdn.example.com/avatar.jpg'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConnectionsService,
        { provide: getDataSourceToken(), useValue: mockDb },
        { provide: StorageService, useValue: mockStorage },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('test-salt') } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get<ConnectionsService>(ConnectionsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── createInvite ───────────────────────────────────────────────────────────

  describe('createInvite', () => {
    function setupHappyPath() {
      mockDb.query
        .mockResolvedValueOnce([{ is_too_new: false }])    // account age check
        .mockResolvedValueOnce([{ count: '1' }])           // daily rate limit
        .mockResolvedValueOnce([{ count: '0' }])           // pending invites count
        .mockResolvedValueOnce([{ id: 'invite-uuid' }]);   // insert invite
    }

    it('generates invite code, deep link and WhatsApp message', async () => {
      setupHappyPath();

      const result = await service.createInvite(
        INVITER_ID,
        { relationship_type: 'parent_child', connection_name: 'Maa' },
        'test-salt',
      );

      expect(result.invite_code).toHaveLength(8);
      expect(result.deep_link).toContain('saanjh.app/join/');
      expect(result.whatsapp_message).toContain(result.deep_link);
      expect(result.whatsapp_message.toLowerCase()).toContain('saanjh');
    });

    it('generates relationship-appropriate WhatsApp message for partners', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ is_too_new: false }])
        .mockResolvedValueOnce([{ count: '1' }])
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([{ id: 'invite-uuid' }]);

      const result = await service.createInvite(
        INVITER_ID,
        { relationship_type: 'partners', connection_name: 'Priya' },
        'test-salt',
      );

      expect(result.whatsapp_message).not.toContain('Maa/Papa');
      expect(result.whatsapp_message).toContain(result.deep_link);
    });

    it('throws ACCOUNT_TOO_NEW for accounts less than 24 hours old', async () => {
      mockDb.query.mockResolvedValueOnce([{ is_too_new: true }]);

      await expect(
        service.createInvite(
          INVITER_ID,
          { relationship_type: 'parent_child', connection_name: 'Maa' },
          'test-salt',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws TOO_MANY_PENDING_INVITES when 3+ pending invites exist', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ is_too_new: false }])
        .mockResolvedValueOnce([{ count: '1' }])    // daily rate limit ok
        .mockResolvedValueOnce([{ count: '3' }]);   // 3 pending → blocked

      await expect(
        service.createInvite(
          INVITER_ID,
          { relationship_type: 'parent_child', connection_name: 'Maa' },
          'test-salt',
        ),
      ).rejects.toThrow(TooManyRequestsException);
    });

    it('expires_at is 7 days from now', async () => {
      setupHappyPath();
      const before = new Date(Date.now() + 6.9 * 24 * 60 * 60 * 1000);
      const after  = new Date(Date.now() + 7.1 * 24 * 60 * 60 * 1000);

      const result = await service.createInvite(
        INVITER_ID,
        { relationship_type: 'siblings', connection_name: 'Bhai' },
        'test-salt',
      );

      expect(result.expires_at.getTime()).toBeGreaterThan(before.getTime());
      expect(result.expires_at.getTime()).toBeLessThan(after.getTime());
    });
  });

  // ── getInviteDetails ───────────────────────────────────────────────────────

  describe('getInviteDetails', () => {
    it('returns safe details without inviter phone or id', async () => {
      mockDb.query
        .mockResolvedValueOnce([makeInvite()])
        .mockResolvedValueOnce([]);  // click_count increment

      const details = await service.getInviteDetails(INVITE_CODE);

      expect(details.valid).toBe(true);
      expect(details.inviter_name).toBe('Adarsh');
      expect(details.relationship_type).toBe('parent_child');
      // Must NOT expose inviter id or phone
      expect(details).not.toHaveProperty('inviter_id');
      expect(details).not.toHaveProperty('inviter_phone');
    });

    it('throws NotFoundException for unknown code', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await expect(service.getInviteDetails('UNKNOWN1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws GoneException for already-accepted invite', async () => {
      mockDb.query.mockResolvedValueOnce([makeInvite({ status: 'accepted' })]);

      await expect(service.getInviteDetails(INVITE_CODE)).rejects.toThrow(
        GoneException,
      );
    });

    it('throws GoneException for expired invite', async () => {
      mockDb.query.mockResolvedValueOnce([
        makeInvite({ expires_at: new Date(Date.now() - 1000) }),
      ]);

      await expect(service.getInviteDetails(INVITE_CODE)).rejects.toThrow(
        GoneException,
      );
    });
  });

  // ── acceptInvite ───────────────────────────────────────────────────────────

  describe('acceptInvite', () => {
    function setupAcceptHappyPath() {
      mockDb.query
        .mockResolvedValueOnce([makeInvite()])         // fetch invite
        .mockResolvedValueOnce([])                     // no existing connection
        .mockResolvedValueOnce([{ id: CONN_ID }])      // insert connection
        .mockResolvedValueOnce([])                     // update invite status
        .mockResolvedValueOnce([])                     // insert notification prefs
        .mockResolvedValueOnce([])                     // audit log
        .mockResolvedValueOnce([{ id: CONN_ID, user_a_id: INVITER_ID, user_b_id: ACCEPTOR_ID }]); // getConnectionById
    }

    it('creates connection and returns it', async () => {
      setupAcceptHappyPath();

      const conn = await service.acceptInvite(
        ACCEPTOR_ID,
        INVITE_CODE,
        'Beta',
      );

      expect(conn).toBeDefined();
    });

    it('enforces pair ordering: smaller UUID is always user_a_id', async () => {
      setupAcceptHappyPath();
      await service.acceptInvite(ACCEPTOR_ID, INVITE_CODE, 'Beta');

      // Find the INSERT diary_connections call
      const insertCall = mockDb.query.mock.calls.find(
        ([sql]: [string]) => sql.includes('INSERT INTO diary_connections'),
      ) as [string, string[]] | undefined;

      expect(insertCall).toBeDefined();
      const [, params] = insertCall!;
      const [userAId, userBId] = params;

      // user_a_id must be lexicographically smaller
      expect(userAId < userBId).toBe(true);
    });

    it('throws CANNOT_ACCEPT_OWN_INVITE when acceptor === inviter', async () => {
      mockDb.query.mockResolvedValueOnce([makeInvite()]);

      await expect(
        service.acceptInvite(INVITER_ID, INVITE_CODE, 'Myself'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ALREADY_CONNECTED when active connection exists', async () => {
      mockDb.query
        .mockResolvedValueOnce([makeInvite()])  // invite found
        .mockResolvedValueOnce([{ 1: 1 }]);     // existing connection found

      await expect(
        service.acceptInvite(ACCEPTOR_ID, INVITE_CODE, 'Beta'),
      ).rejects.toThrow(ConflictException);
    });

    it('throws GoneException for expired invite', async () => {
      mockDb.query.mockResolvedValueOnce([
        makeInvite({ status: 'pending', expires_at: new Date(Date.now() - 1000) }),
      ]);

      await expect(
        service.acceptInvite(ACCEPTOR_ID, INVITE_CODE, 'Beta'),
      ).rejects.toThrow(GoneException);
    });
  });

  // ── renameConnection ───────────────────────────────────────────────────────

  describe('renameConnection', () => {
    it('updates the correct name column using CASE WHEN', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await service.renameConnection(INVITER_ID, CONN_ID, 'Amma');

      const [sql, params] = mockDb.query.mock.calls[0] as [string, string[]];
      expect(sql).toContain('name_for_a');
      expect(sql).toContain('name_for_b');
      expect(sql).toContain('CASE WHEN user_a_id');
      expect(params).toContain('Amma');
      expect(params).toContain(INVITER_ID);
    });

    it('trims whitespace from new name', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await service.renameConnection(INVITER_ID, CONN_ID, '  Amma  ');

      const params = mockDb.query.mock.calls[0][1] as string[];
      expect(params).toContain('Amma');
      expect(params).not.toContain('  Amma  ');
    });
  });

  // ── checkPendingInvite ────────────────────────────────────────────────────

  describe('checkPendingInvite (auto-match on signup)', () => {
    it('silently returns when no pending invite found', async () => {
      mockDb.query.mockResolvedValueOnce([]); // no pending invite

      await expect(
        service.checkPendingInvite({
          userId: ACCEPTOR_ID,
          phoneHash: 'abc123',
          salt: 'salt',
        }),
      ).resolves.not.toThrow();
    });

    it('calls acceptInvite with invite_code when pending invite found', async () => {
      const invite = makeInvite();
      mockDb.query
        .mockResolvedValueOnce([invite])               // find pending invite
        // acceptInvite calls:
        .mockResolvedValueOnce([invite])               // fetch invite by code
        .mockResolvedValueOnce([])                     // no existing connection
        .mockResolvedValueOnce([{ id: CONN_ID }])      // insert connection
        .mockResolvedValueOnce([])                     // update invite status
        .mockResolvedValueOnce([])                     // notification prefs
        .mockResolvedValueOnce([])                     // audit log
        .mockResolvedValueOnce([{ id: CONN_ID }]);     // getConnectionById

      await service.checkPendingInvite({
        userId: ACCEPTOR_ID,
        phoneHash: 'hashedPhone',
        salt: 'salt',
      });

      // Verify acceptInvite was called (connection insert should exist)
      const insertCall = mockDb.query.mock.calls.find(
        ([sql]: [string]) => sql.includes('INSERT INTO diary_connections'),
      );
      expect(insertCall).toBeDefined();
    });

    it('never throws even if acceptInvite fails', async () => {
      mockDb.query
        .mockResolvedValueOnce([makeInvite()])       // pending invite found
        .mockRejectedValueOnce(new Error('DB error')); // acceptInvite fails

      await expect(
        service.checkPendingInvite({
          userId: ACCEPTOR_ID,
          phoneHash: 'hashedPhone',
          salt: 'salt',
        }),
      ).resolves.not.toThrow();
    });
  });
});
