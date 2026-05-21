import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EntriesService } from './entries.service';
import { StorageService } from '../shared/storage/storage.service';
import { StreaksService } from '../streaks/streaks.service';
import { TooManyRequestsException } from '../shared/exceptions/too-many-requests.exception';

const CONNECTION_ID = 'conn-uuid-001';
const AUTHOR_ID     = 'user-uuid-001';
const OTHER_ID      = 'user-uuid-002';
const ENTRY_ID      = 'entry-uuid-001';

function makeDbEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    connection_id: CONNECTION_ID,
    author_id: AUTHOR_ID,
    entry_type: 'voice',
    media_key: `entries/shared/${CONNECTION_ID}/2026/05/${ENTRY_ID}.m4a`,
    thumbnail_key: null,
    duration_seconds: 15,
    file_size_bytes: 180000,
    transcription: null,
    transcription_status: 'pending',
    mood: 'happy',
    is_starred: false,
    starred_at: null,
    play_count: 0,
    recorded_at: new Date('2026-05-20T14:30:00Z'),
    created_at: new Date('2026-05-20T14:30:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

describe('EntriesService', () => {
  let service: EntriesService;
  let mockDb: { query: jest.Mock };
  let mockStorage: Partial<StorageService>;
  let mockEventEmitter: { emit: jest.Mock };
  let mockStreaks: Partial<StreaksService>;

  beforeEach(async () => {
    mockDb = { query: jest.fn() };
    mockStorage = {
      objectExists: jest.fn().mockResolvedValue(true),
      getPresignedUploadUrl: jest.fn().mockResolvedValue('https://r2.upload.url'),
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://r2.play.url'),
    };
    mockEventEmitter = { emit: jest.fn() };
    mockStreaks = { onNewEntry: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntriesService,
        { provide: getDataSourceToken(), useValue: mockDb },
        { provide: StorageService, useValue: mockStorage },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: StreaksService, useValue: mockStreaks },
      ],
    }).compile();

    service = module.get<EntriesService>(EntriesService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── getUploadUrl ───────────────────────────────────────────────────────────

  describe('getUploadUrl', () => {
    it('returns pre-signed upload URL with entry_id and media_key', async () => {
      mockDb.query.mockResolvedValueOnce([{ count: '1' }]); // rate limit ok

      const result = await service.getUploadUrl(
        AUTHOR_ID,
        CONNECTION_ID,
        { entry_type: 'voice', file_extension: 'm4a', duration_seconds: 15, file_size_bytes: 180000 },
      );

      expect(result.upload_url).toBe('https://r2.upload.url');
      expect(result.media_key).toContain(CONNECTION_ID);
      expect(result.media_key).toContain('.m4a');
      expect(result.entry_id).toHaveLength(36); // UUID format
      expect(result.expires_in).toBe(900);
    });

    it('uses voiceKey for voice entries', async () => {
      mockDb.query.mockResolvedValueOnce([{ count: '1' }]);

      const result = await service.getUploadUrl(
        AUTHOR_ID,
        CONNECTION_ID,
        { entry_type: 'voice', file_extension: 'm4a', duration_seconds: 10, file_size_bytes: 100000 },
      );

      expect(result.media_key).toContain('entries/shared/');
      expect(result.media_key).toMatch(/\.m4a$/);
    });

    it('uses videoKey for video entries', async () => {
      mockDb.query.mockResolvedValueOnce([{ count: '1' }]);

      const result = await service.getUploadUrl(
        AUTHOR_ID,
        CONNECTION_ID,
        { entry_type: 'video', file_extension: 'mp4', duration_seconds: 18, file_size_bytes: 5000000 },
      );

      expect(result.media_key).toMatch(/\.mp4$/);
    });

    it('throws UPLOAD_RATE_LIMIT when 30 uploads exceeded', async () => {
      mockDb.query.mockResolvedValueOnce([{ count: '31' }]); // over limit

      await expect(
        service.getUploadUrl(
          AUTHOR_ID,
          CONNECTION_ID,
          { entry_type: 'voice', file_extension: 'm4a', duration_seconds: 10, file_size_bytes: 100000 },
        ),
      ).rejects.toThrow(TooManyRequestsException);
    });
  });

  // ── createEntry ────────────────────────────────────────────────────────────

  describe('createEntry', () => {
    const validMediaKey = `entries/shared/${CONNECTION_ID}/2026/05/${ENTRY_ID}.m4a`;

    function setupHappyPath() {
      // Streak logic is now handled by StreaksService (mocked above).
      // EntriesService only does: INSERT entry, UPDATE counters, cache delete, audit log.
      mockDb.query
        .mockResolvedValueOnce([makeDbEntry()])  // INSERT entry RETURNING
        .mockResolvedValueOnce([])               // UPDATE connection counters
        .mockResolvedValueOnce([])               // DELETE memory_tree_cache
        .mockResolvedValueOnce([]);              // audit log
    }

    it('creates entry and returns public shape (no media_key exposed)', async () => {
      setupHappyPath();

      const entry = await service.createEntry(AUTHOR_ID, CONNECTION_ID, {
        media_key: validMediaKey,
        entry_type: 'voice',
        duration_seconds: 15,
      });

      expect(entry.id).toBe(ENTRY_ID);
      expect(entry.entry_type).toBe('voice');
      // media_key must NOT be in the public shape
      expect(entry).not.toHaveProperty('media_key');
      expect(entry).not.toHaveProperty('thumbnail_key');
    });

    it('throws MEDIA_NOT_UPLOADED when R2 object does not exist', async () => {
      (mockStorage.objectExists as jest.Mock).mockResolvedValueOnce(false);

      await expect(
        service.createEntry(AUTHOR_ID, CONNECTION_ID, {
          media_key: validMediaKey,
          entry_type: 'voice',
          duration_seconds: 15,
        }),
      ).rejects.toThrow(BadRequestException);

      const err = await service
        .createEntry(AUTHOR_ID, CONNECTION_ID, {
          media_key: validMediaKey,
          entry_type: 'voice',
          duration_seconds: 15,
        })
        .catch((e: BadRequestException) => e);

      // Reset and check the error code
      (mockStorage.objectExists as jest.Mock).mockResolvedValueOnce(false);
      let caught: BadRequestException | null = null;
      await service
        .createEntry(AUTHOR_ID, CONNECTION_ID, {
          media_key: validMediaKey, entry_type: 'voice', duration_seconds: 15,
        })
        .catch((e: BadRequestException) => { caught = e; });

      const body = (caught as unknown as BadRequestException)?.getResponse() as { error: string } | undefined;
      if (body) expect(body.error).toBe('MEDIA_NOT_UPLOADED');
    });

    it('throws INVALID_MEDIA_KEY when key belongs to different connection', async () => {
      const wrongKey = `entries/shared/different-conn/2026/05/entry.m4a`;

      await expect(
        service.createEntry(AUTHOR_ID, CONNECTION_ID, {
          media_key: wrongKey,
          entry_type: 'voice',
          duration_seconds: 15,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('emits entry.created event for async workers', async () => {
      setupHappyPath();

      await service.createEntry(AUTHOR_ID, CONNECTION_ID, {
        media_key: validMediaKey,
        entry_type: 'voice',
        duration_seconds: 15,
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'entry.created',
        expect.objectContaining({
          entryId: ENTRY_ID,
          connectionId: CONNECTION_ID,
          authorId: AUTHOR_ID,
          entryType: 'voice',
        }),
      );
    });
  });

  // ── listEntries ────────────────────────────────────────────────────────────

  describe('listEntries', () => {
    it('returns entries without media_key or thumbnail_key', async () => {
      const entries = [makeDbEntry(), makeDbEntry({ id: 'entry-uuid-002' })];
      mockDb.query
        .mockResolvedValueOnce(entries)                    // SELECT entries
        .mockResolvedValueOnce([{ total_entry_count: '10' }]); // COUNT

      const result = await service.listEntries(AUTHOR_ID, CONNECTION_ID, { limit: 20 });

      expect(result.entries).toHaveLength(2);
      result.entries.forEach((e) => {
        expect(e).not.toHaveProperty('media_key');
        expect(e).not.toHaveProperty('thumbnail_key');
      });
    });

    it('detects has_more by fetching limit+1 rows', async () => {
      // Return 21 rows for limit=20 → has_more=true
      const manyEntries = Array.from({ length: 21 }, (_, i) =>
        makeDbEntry({ id: `entry-${i}`, recorded_at: new Date(Date.now() - i * 1000) }),
      );
      mockDb.query
        .mockResolvedValueOnce(manyEntries)
        .mockResolvedValueOnce([{ total_entry_count: '25' }]);

      const result = await service.listEntries(AUTHOR_ID, CONNECTION_ID, { limit: 20 });

      expect(result.has_more).toBe(true);
      expect(result.entries).toHaveLength(20); // only 20 returned
      expect(result.next_cursor).not.toBeNull();
    });

    it('returns has_more=false when fewer items than limit', async () => {
      mockDb.query
        .mockResolvedValueOnce([makeDbEntry()])
        .mockResolvedValueOnce([{ total_entry_count: '1' }]);

      const result = await service.listEntries(AUTHOR_ID, CONNECTION_ID, { limit: 20 });

      expect(result.has_more).toBe(false);
      expect(result.next_cursor).toBeNull();
    });

    it('adds filter clause for voice/video/starred', async () => {
      mockDb.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total_entry_count: '0' }]);

      await service.listEntries(AUTHOR_ID, CONNECTION_ID, { filter: 'voice' });

      const [sql] = mockDb.query.mock.calls[0] as [string];
      expect(sql).toContain(`entry_type = 'voice'`);
    });
  });

  // ── getEntry ───────────────────────────────────────────────────────────────

  describe('getEntry', () => {
    it('returns entry with signed media URL', async () => {
      mockDb.query.mockResolvedValueOnce([makeDbEntry()]);

      const result = await service.getEntry(AUTHOR_ID, CONNECTION_ID, ENTRY_ID);

      expect(result.media_url).toBe('https://r2.play.url');
      expect(result.thumbnail_url).toBeNull(); // voice entry — no thumbnail
    });

    it('returns signed thumbnail URL for video entries', async () => {
      mockDb.query.mockResolvedValueOnce([
        makeDbEntry({
          entry_type: 'video',
          thumbnail_key: `entries/thumbs/${CONNECTION_ID}/2026/05/${ENTRY_ID}.jpg`,
        }),
      ]);
      (mockStorage.getSignedDownloadUrl as jest.Mock)
        .mockResolvedValueOnce('https://r2.play.mp4')
        .mockResolvedValueOnce('https://r2.thumb.jpg');

      const result = await service.getEntry(AUTHOR_ID, CONNECTION_ID, ENTRY_ID);

      expect(result.thumbnail_url).toBe('https://r2.thumb.jpg');
    });

    it('throws NotFoundException for deleted entry', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await expect(
        service.getEntry(AUTHOR_ID, CONNECTION_ID, ENTRY_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── softDeleteEntry ────────────────────────────────────────────────────────

  describe('softDeleteEntry', () => {
    it('sets deleted_at and updates connection counters', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ author_id: AUTHOR_ID, recorded_at: new Date() }]) // find entry
        .mockResolvedValueOnce([])   // SET deleted_at
        .mockResolvedValueOnce([])   // audit log
        .mockResolvedValueOnce([])   // update last_entry_at
        .mockResolvedValueOnce([]);  // delete cache

      await service.softDeleteEntry(AUTHOR_ID, CONNECTION_ID, ENTRY_ID);

      const deleteSql = mockDb.query.mock.calls[1][0] as string;
      expect(deleteSql).toContain('deleted_at = NOW()');
      expect(deleteSql).not.toContain('DELETE FROM diary_entries');
    });

    it('throws NOT_ENTRY_AUTHOR when non-author tries to delete', async () => {
      mockDb.query.mockResolvedValueOnce([
        { author_id: AUTHOR_ID, recorded_at: new Date() }, // owner is AUTHOR_ID
      ]);

      await expect(
        service.softDeleteEntry(OTHER_ID, CONNECTION_ID, ENTRY_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException when entry not found', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await expect(
        service.softDeleteEntry(AUTHOR_ID, CONNECTION_ID, ENTRY_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── recordPlay ─────────────────────────────────────────────────────────────

  describe('recordPlay', () => {
    it('increments play_count and returns updated value', async () => {
      mockDb.query.mockResolvedValueOnce([{ play_count: 3 }]);

      const result = await service.recordPlay(AUTHOR_ID, CONNECTION_ID, ENTRY_ID);

      expect(result.play_count).toBe(3);

      const [sql] = mockDb.query.mock.calls[0] as [string];
      expect(sql).toContain('play_count = play_count + 1');
    });

    it('throws NotFoundException when entry not found', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await expect(
        service.recordPlay(AUTHOR_ID, CONNECTION_ID, ENTRY_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Streak delegation ──────────────────────────────────────────────────────

  describe('streak delegation (via createEntry)', () => {
    const mediaKey = `entries/shared/${CONNECTION_ID}/2026/05/${ENTRY_ID}.m4a`;

    it('delegates streak update to StreaksService.onNewEntry()', async () => {
      mockDb.query
        .mockResolvedValueOnce([makeDbEntry()])  // INSERT entry
        .mockResolvedValueOnce([])               // UPDATE counters
        .mockResolvedValueOnce([])               // DELETE cache
        .mockResolvedValueOnce([]);              // audit log

      await service.createEntry(AUTHOR_ID, CONNECTION_ID, {
        media_key: mediaKey,
        entry_type: 'voice',
        duration_seconds: 15,
      });

      expect(mockStreaks.onNewEntry).toHaveBeenCalledWith(
        CONNECTION_ID,
        expect.any(Date),
      );
    });

    it('streak failure never blocks entry creation', async () => {
      (mockStreaks.onNewEntry as jest.Mock).mockRejectedValueOnce(
        new Error('streak DB error'),
      );

      mockDb.query
        .mockResolvedValueOnce([makeDbEntry()])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await expect(
        service.createEntry(AUTHOR_ID, CONNECTION_ID, {
          media_key: mediaKey,
          entry_type: 'voice',
          duration_seconds: 15,
        }),
      ).resolves.not.toThrow();
    });
  });
});
