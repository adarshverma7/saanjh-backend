import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { MemoryJarService } from './memory-jar.service';
import {
  decodeStarredCursor,
  encodeStarredCursor,
} from '../shared/helpers/pagination.helper';

const CONN_ID = 'conn-uuid-001';
const USER_ID = 'user-uuid-001';
const GATE_KEY = `jar_gate:${USER_ID}:${CONN_ID}`;

function makeEntry(id: string, starredAt: Date = new Date()) {
  return {
    id,
    connection_id: CONN_ID,
    author_id: USER_ID,
    entry_type: 'voice',
    duration_seconds: 12,
    transcription: 'yaad rakhna',
    transcription_status: 'done',
    mood: 'happy',
    is_starred: true,
    starred_at: starredAt,
    play_count: 3,
    recorded_at: new Date('2025-01-15T10:00:00Z'),
    created_at: new Date('2025-01-15T10:00:00Z'),
  };
}

describe('MemoryJarService', () => {
  let service: MemoryJarService;
  let mockDb: { query: jest.Mock };

  beforeEach(async () => {
    mockDb = { query: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryJarService,
        { provide: getDataSourceToken(), useValue: mockDb },
      ],
    }).compile();

    service = module.get<MemoryJarService>(MemoryJarService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── surfaceMemory ──────────────────────────────────────────────────────────

  describe('surfaceMemory', () => {
    it('returns surfaced=true and a random entry when gate is clear', async () => {
      const entry = makeEntry('star-001');
      mockDb.query
        .mockResolvedValueOnce([{ count: '5' }])    // total_starred
        .mockResolvedValueOnce([])                  // gate check → expired
        .mockResolvedValueOnce([entry])             // random starred entry
        .mockResolvedValueOnce([]);                 // upsert gate

      const result = await service.surfaceMemory(USER_ID, CONN_ID);

      expect(result.surfaced).toBe(true);
      expect(result.entry).not.toBeNull();
      expect(result.entry?.id).toBe('star-001');
      expect(result.total_starred).toBe(5);
    });

    it('returns surfaced=false with total_starred when within gate window', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ count: '3' }])              // total_starred
        .mockResolvedValueOnce([{ updated_at: new Date() }]); // gate active → within 4h

      const result = await service.surfaceMemory(USER_ID, CONN_ID);

      expect(result.surfaced).toBe(false);
      expect(result.entry).toBeNull();
      expect(result.total_starred).toBe(3);
      // Must not query diary_entries when gated
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });

    it('returns surfaced=false when no starred entries exist', async () => {
      mockDb.query.mockResolvedValueOnce([{ count: '0' }]); // total_starred = 0

      const result = await service.surfaceMemory(USER_ID, CONN_ID);

      expect(result.surfaced).toBe(false);
      expect(result.entry).toBeNull();
      expect(result.total_starred).toBe(0);
      // No gate check or entry fetch needed
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it('uses correct gate key including both userId and connectionId', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ count: '1' }])
        .mockResolvedValueOnce([])                 // gate check
        .mockResolvedValueOnce([makeEntry('e1')])
        .mockResolvedValueOnce([]);

      await service.surfaceMemory(USER_ID, CONN_ID);

      // Gate check query (call index 1) must use the correct key
      const gateCheckCall = mockDb.query.mock.calls[1] as [string, unknown[]];
      expect(gateCheckCall[1][0]).toBe(GATE_KEY);
    });

    it('upserts gate after successful surface', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ count: '1' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeEntry('e1')])
        .mockResolvedValueOnce([]);

      await service.surfaceMemory(USER_ID, CONN_ID);

      // Gate upsert is the last DB call
      const upsertCall = mockDb.query.mock.calls[3] as [string, unknown[]];
      expect(upsertCall[0]).toContain('ON CONFLICT (key) DO UPDATE');
      expect(upsertCall[1][0]).toBe(GATE_KEY);
    });

    it('uses 4-hour window in the gate check query', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ count: '1' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeEntry('e1')])
        .mockResolvedValueOnce([]);

      await service.surfaceMemory(USER_ID, CONN_ID);

      const gateCall = mockDb.query.mock.calls[1] as [string, unknown[]];
      // The query uses INTERVAL '1 hour' * $2 where $2 = 4
      expect(gateCall[1][1]).toBe(4);
    });

    it('uses ORDER BY RANDOM() for MVP randomness', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ count: '10' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeEntry('e1')])
        .mockResolvedValueOnce([]);

      await service.surfaceMemory(USER_ID, CONN_ID);

      const entryCall = mockDb.query.mock.calls[2] as [string];
      expect(entryCall[0]).toContain('ORDER BY RANDOM()');
    });
  });

  // ── getAllStarred ───────────────────────────────────────────────────────────

  describe('getAllStarred', () => {
    it('returns starred entries ordered by starred_at DESC', async () => {
      const entries = [
        makeEntry('e3', new Date('2026-05-15T10:00:00Z')),
        makeEntry('e2', new Date('2026-04-10T10:00:00Z')),
        makeEntry('e1', new Date('2026-03-01T10:00:00Z')),
      ];
      mockDb.query
        .mockResolvedValueOnce(entries)          // entries (limit+1)
        .mockResolvedValueOnce([{ count: '3' }]); // total

      const result = await service.getAllStarred(USER_ID, CONN_ID, 20);

      expect(result.entries).toHaveLength(3);
      expect(result.total_starred).toBe(3);
      expect(result.has_more).toBe(false);
      expect(result.next_cursor).toBeNull();

      const [sql] = mockDb.query.mock.calls[0] as [string];
      expect(sql).toContain('ORDER BY starred_at DESC');
    });

    it('detects has_more by fetching limit+1 rows', async () => {
      // 21 rows for limit=20 → has_more
      const entries = Array.from({ length: 21 }, (_, i) =>
        makeEntry(`e${i}`, new Date(Date.now() - i * 1000)),
      );
      mockDb.query
        .mockResolvedValueOnce(entries)
        .mockResolvedValueOnce([{ count: '50' }]);

      const result = await service.getAllStarred(USER_ID, CONN_ID, 20);

      expect(result.has_more).toBe(true);
      expect(result.entries).toHaveLength(20);
      expect(result.next_cursor).not.toBeNull();
    });

    it('next_cursor encodes (starred_at, id) of the last entry', async () => {
      const last = makeEntry('last-entry', new Date('2026-05-10T10:00:00Z'));
      const entries = Array.from({ length: 21 }, (_, i) =>
        i < 20 ? makeEntry(`e${i}`, new Date(Date.now() - i * 1000)) : last,
      );
      mockDb.query
        .mockResolvedValueOnce(entries)
        .mockResolvedValueOnce([{ count: '25' }]);

      const result = await service.getAllStarred(USER_ID, CONN_ID, 20);

      // Decode the cursor and verify it matches the 20th entry (last included)
      const lastIncluded = entries[19];
      const decoded = decodeStarredCursor(result.next_cursor!);
      expect(decoded).not.toBeNull();
      expect(decoded?.id).toBe(lastIncluded.id);
    });

    it('adds cursor WHERE clause when cursor is provided', async () => {
      const starredAt = new Date('2026-05-01T10:00:00Z');
      const cursor = encodeStarredCursor(starredAt, 'prev-id');

      mockDb.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: '0' }]);

      await service.getAllStarred(USER_ID, CONN_ID, 20, cursor);

      const [sql] = mockDb.query.mock.calls[0] as [string];
      expect(sql).toContain('starred_at <');
    });

    it('ignores invalid cursor and returns from start', async () => {
      mockDb.query
        .mockResolvedValueOnce([makeEntry('e1')])
        .mockResolvedValueOnce([{ count: '1' }]);

      const result = await service.getAllStarred(
        USER_ID,
        CONN_ID,
        20,
        'not-a-valid-cursor',
      );

      expect(result.entries).toHaveLength(1);
    });
  });
});
