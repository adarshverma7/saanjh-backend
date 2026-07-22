import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { CleanupWorker } from './cleanup.worker';
import { StorageService } from '../shared/storage/storage.service';

const USER_ID = 'user-uuid-del';
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe('CleanupWorker.hardDeleteUser', () => {
  let worker: CleanupWorker;
  let mockDb: { query: jest.Mock };
  let mockStorage: Partial<StorageService>;

  beforeEach(async () => {
    mockDb = { query: jest.fn().mockResolvedValue([]) };
    mockStorage = { deleteObject: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CleanupWorker,
        { provide: getDataSourceToken(), useValue: mockDb },
        { provide: StorageService, useValue: mockStorage },
      ],
    }).compile();

    worker = module.get<CleanupWorker>(CleanupWorker);
  });

  afterEach(() => jest.clearAllMocks());

  const sqlOf = (substr: string) =>
    mockDb.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes(substr),
    );

  it('skips when the user is not found', async () => {
    mockDb.query.mockResolvedValueOnce([]); // SELECT deleted_at → none

    await worker.hardDeleteUser(USER_ID);

    expect(mockDb.query).toHaveBeenCalledTimes(1); // only the lookup
    expect(sqlOf('DELETE FROM users')).toBeUndefined();
  });

  it('refuses to purge before the 30-day grace period elapses', async () => {
    mockDb.query.mockResolvedValueOnce([{ deleted_at: daysAgo(5) }]);

    await worker.hardDeleteUser(USER_ID);

    expect(mockDb.query).toHaveBeenCalledTimes(1); // guard returned before any DELETE
    expect(sqlOf('DELETE FROM users')).toBeUndefined();
  });

  it('skips a user that was never soft-deleted', async () => {
    mockDb.query.mockResolvedValueOnce([{ deleted_at: null }]);

    await worker.hardDeleteUser(USER_ID);

    expect(sqlOf('DELETE FROM users')).toBeUndefined();
  });

  it('purges all personal data, anonymises shared entries, and audits when the grace period has passed', async () => {
    mockDb.query
      .mockResolvedValueOnce([{ deleted_at: daysAgo(40) }])       // SELECT deleted_at
      .mockResolvedValueOnce([{ media_key: 'journal/u/1.m4a' }]); // journal media keys
    // remaining queries resolve [] via the default mock

    await worker.hardDeleteUser(USER_ID);

    expect(sqlOf('DELETE FROM personal_journal_entries')).toBeDefined();
    expect(sqlOf('DELETE FROM device_sessions')).toBeDefined();
    expect(sqlOf('UPDATE diary_entries SET author_id = NULL')).toBeDefined();
    expect(sqlOf('DELETE FROM users')).toBeDefined();
    // Journal media queued for storage deletion
    expect(mockStorage.deleteObject).toHaveBeenCalledWith('journal/u/1.m4a');
    // Audit log written with a NULL user_id (row is gone) and the right action
    const audit = sqlOf('audit_logs');
    expect(audit).toBeDefined();
    expect(audit![0]).toContain('account.hard_deleted');
  });
});
