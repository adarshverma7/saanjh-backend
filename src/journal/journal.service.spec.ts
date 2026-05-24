import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { JournalService } from './journal.service';
import { StorageService } from '../shared/storage/storage.service';

const USER_ID    = 'user-uuid-001';
const OTHER_USER = 'user-uuid-002';
const ENTRY_ID   = 'entry-uuid-001';

function makeDbEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    user_id: USER_ID,
    entry_type: 'voice',
    media_key: `entries/journal/${USER_ID}/2026/05/${ENTRY_ID}.m4a`,
    text_content: null,
    duration_seconds: 45,
    mood: 'calm',
    is_starred: false,
    recorded_at: new Date('2026-05-20T10:00:00Z'),
    created_at: new Date('2026-05-20T10:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

describe('JournalService', () => {
  let service: JournalService;
  let mockDb: { query: jest.Mock };
  let mockStorage: Partial<StorageService>;

  beforeEach(async () => {
    mockDb = { query: jest.fn() };
    mockStorage = {
      objectExists: jest.fn().mockResolvedValue(true),
      getSignedUploadUrl: jest.fn().mockResolvedValue('https://r2.upload.url'),
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://r2.play.url'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JournalService,
        { provide: getDataSourceToken(), useValue: mockDb },
        { provide: StorageService, useValue: mockStorage },
      ],
    }).compile();

    service = module.get<JournalService>(JournalService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Security invariants ────────────────────────────────────────────────────

  describe('security invariants', () => {
    it('every DB query includes user_id = $userId (listEntries)', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await service.listEntries(USER_ID, { limit: 20 });

      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('user_id = $1');
      expect(params[0]).toBe(USER_ID);
    });

    it('getEntry enforces user_id in WHERE clause', async () => {
      mockDb.query.mockResolvedValueOnce([makeDbEntry()]);

      await service.getEntry(USER_ID, ENTRY_ID);

      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('user_id = $2');
      expect(params[0]).toBe(ENTRY_ID);
      expect(params[1]).toBe(USER_ID);
    });

    it('starEntry enforces user_id in WHERE clause', async () => {
      mockDb.query.mockResolvedValueOnce([makeDbEntry({ is_starred: true })]);

      await service.starEntry(USER_ID, ENTRY_ID, true);

      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('user_id = $3');
      expect(params[2]).toBe(USER_ID);
    });

    it('deleteEntry enforces user_id in WHERE clause', async () => {
      mockDb.query.mockResolvedValueOnce([{ id: ENTRY_ID }]);

      await service.deleteEntry(USER_ID, ENTRY_ID);

      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('user_id = $2');
      expect(params[1]).toBe(USER_ID);
    });

    it('rejects media_key that does not belong to this user', async () => {
      const wrongKey = `entries/journal/${OTHER_USER}/2026/05/${ENTRY_ID}.m4a`;

      await expect(
        service.createEntry(USER_ID, {
          entry_type: 'voice',
          media_key: wrongKey,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('media_key must start with entries/journal/${userId}/', async () => {
      // This should pass — key belongs to the correct user
      mockDb.query.mockResolvedValueOnce([makeDbEntry()]);

      await service.createEntry(USER_ID, {
        entry_type: 'voice',
        media_key: `entries/journal/${USER_ID}/2026/05/entry.m4a`,
      });

      expect(mockDb.query).toHaveBeenCalled();
    });
  });

  // ── getUploadUrl ───────────────────────────────────────────────────────────

  describe('getUploadUrl', () => {
    it('generates a journal-scoped media key for the user', async () => {
      const result = await service.getUploadUrl(USER_ID, {
        entry_type: 'voice',
        file_extension: 'm4a',
      });

      expect(result.upload_url).toBe('https://r2.upload.url');
      expect(result.media_key).toContain(`entries/journal/${USER_ID}/`);
      expect(result.expires_in).toBe(900);
    });

    it('uses .mp4 extension for video entries', async () => {
      const result = await service.getUploadUrl(USER_ID, {
        entry_type: 'video',
        file_extension: 'mp4',
      });

      expect(result.media_key).toContain('.mp4');
    });

    it('uses .m4a extension for voice entries', async () => {
      const result = await service.getUploadUrl(USER_ID, {
        entry_type: 'voice',
        file_extension: 'm4a',
      });

      expect(result.media_key).toContain('.m4a');
    });
  });

  // ── createEntry ────────────────────────────────────────────────────────────

  describe('createEntry', () => {
    it('creates a voice entry and returns public shape (no media_key)', async () => {
      mockDb.query.mockResolvedValueOnce([makeDbEntry()]);

      const entry = await service.createEntry(USER_ID, {
        entry_type: 'voice',
        media_key: `entries/journal/${USER_ID}/2026/05/e.m4a`,
        duration_seconds: 45,
        mood: 'calm',
      });

      expect(entry.id).toBe(ENTRY_ID);
      expect(entry.entry_type).toBe('voice');
      expect(entry).not.toHaveProperty('media_key');
    });

    it('creates a text entry without media_key', async () => {
      const textEntry = makeDbEntry({
        entry_type: 'text',
        media_key: null,
        text_content: 'Today I felt grateful.',
      });
      mockDb.query.mockResolvedValueOnce([textEntry]);

      const entry = await service.createEntry(USER_ID, {
        entry_type: 'text',
        text_content: 'Today I felt grateful.',
      });

      expect(entry.text_content).toBe('Today I felt grateful.');
      expect(entry.entry_type).toBe('text');
    });

    it('throws TEXT_REQUIRED when text entry has no text_content', async () => {
      await expect(
        service.createEntry(USER_ID, { entry_type: 'text' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws MEDIA_NOT_UPLOADED when R2 object missing', async () => {
      (mockStorage.objectExists as jest.Mock).mockResolvedValueOnce(false);

      await expect(
        service.createEntry(USER_ID, {
          entry_type: 'voice',
          media_key: `entries/journal/${USER_ID}/2026/05/e.m4a`,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── listEntries ────────────────────────────────────────────────────────────

  describe('listEntries', () => {
    it('returns entries without media_key exposed', async () => {
      mockDb.query.mockResolvedValueOnce([makeDbEntry(), makeDbEntry({ id: 'e2' })]);

      const result = await service.listEntries(USER_ID, { limit: 20 });

      expect(result.entries).toHaveLength(2);
      result.entries.forEach((e) => expect(e).not.toHaveProperty('media_key'));
    });

    it('detects has_more via limit+1 pattern', async () => {
      const many = Array.from({ length: 21 }, (_, i) =>
        makeDbEntry({ id: `e${i}`, recorded_at: new Date(Date.now() - i * 1000) }),
      );
      mockDb.query.mockResolvedValueOnce(many);

      const result = await service.listEntries(USER_ID, { limit: 20 });

      expect(result.has_more).toBe(true);
      expect(result.entries).toHaveLength(20);
      expect(result.next_cursor).not.toBeNull();
    });

    it('applies text filter correctly', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await service.listEntries(USER_ID, { filter: 'text' });

      const [sql] = mockDb.query.mock.calls[0] as [string];
      expect(sql).toContain(`entry_type = 'text'`);
    });

    it('applies starred filter correctly', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await service.listEntries(USER_ID, { filter: 'starred' });

      const [sql] = mockDb.query.mock.calls[0] as [string];
      expect(sql).toContain('is_starred = true');
    });
  });

  // ── getEntry ───────────────────────────────────────────────────────────────

  describe('getEntry', () => {
    it('returns entry with signed media URL for voice/video', async () => {
      mockDb.query.mockResolvedValueOnce([makeDbEntry()]);

      const result = await service.getEntry(USER_ID, ENTRY_ID);

      expect(result.media_url).toBe('https://r2.play.url');
    });

    it('returns null media_url for text entries', async () => {
      mockDb.query.mockResolvedValueOnce([
        makeDbEntry({ entry_type: 'text', media_key: null }),
      ]);

      const result = await service.getEntry(USER_ID, ENTRY_ID);

      expect(result.media_url).toBeNull();
      expect(mockStorage.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when entry not found', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await expect(service.getEntry(USER_ID, ENTRY_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when entry belongs to another user', async () => {
      // DB returns empty because WHERE user_id = $userId filters it out
      mockDb.query.mockResolvedValueOnce([]);

      await expect(
        service.getEntry(OTHER_USER, ENTRY_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── deleteEntry ────────────────────────────────────────────────────────────

  describe('deleteEntry', () => {
    it('soft-deletes (sets deleted_at), does not hard delete', async () => {
      mockDb.query.mockResolvedValueOnce([{ id: ENTRY_ID }]);

      await service.deleteEntry(USER_ID, ENTRY_ID);

      const [sql] = mockDb.query.mock.calls[0] as [string];
      expect(sql).toContain('deleted_at = NOW()');
      expect(sql).not.toContain('DELETE FROM personal_journal_entries');
    });

    it('throws NotFoundException when entry not found or belongs to another user', async () => {
      mockDb.query.mockResolvedValueOnce([]); // RETURNING id → empty

      await expect(
        service.deleteEntry(USER_ID, ENTRY_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
