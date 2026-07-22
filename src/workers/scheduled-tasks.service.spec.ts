import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { ScheduledTasksService } from './scheduled-tasks.service';
import { CleanupWorker } from './cleanup.worker';

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

async function build(queue: { add: jest.Mock } | null) {
  const mockDb = { query: jest.fn().mockResolvedValue([]) };
  const mockCleanupWorker = { hardDeleteUser: jest.fn().mockResolvedValue(undefined) };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ScheduledTasksService,
      { provide: getDataSourceToken(), useValue: mockDb },
      { provide: CleanupWorker, useValue: mockCleanupWorker },
      { provide: getQueueToken('cleanup'), useValue: queue },
    ],
  }).compile();

  return {
    service: module.get<ScheduledTasksService>(ScheduledTasksService),
    mockDb,
    mockCleanupWorker,
  };
}

describe('ScheduledTasksService.hardDeleteScheduledAccounts', () => {
  afterEach(() => jest.clearAllMocks());

  it('runs the hard delete inline for each due account when Redis/Bull is absent', async () => {
    const { service, mockDb, mockCleanupWorker } = await build(null);
    mockDb.query.mockResolvedValueOnce([
      { id: 'u1', deleted_at: daysAgo(31) },
      { id: 'u2', deleted_at: daysAgo(45) },
    ]);

    await service.hardDeleteScheduledAccounts();

    expect(mockCleanupWorker.hardDeleteUser).toHaveBeenCalledWith('u1');
    expect(mockCleanupWorker.hardDeleteUser).toHaveBeenCalledWith('u2');
    expect(mockCleanupWorker.hardDeleteUser).toHaveBeenCalledTimes(2);
  });

  it('queues a delete_user_data job (and does NOT run inline) when a queue is available', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const { service, mockDb, mockCleanupWorker } = await build(queue);
    mockDb.query.mockResolvedValueOnce([{ id: 'u1', deleted_at: daysAgo(31) }]);

    await service.hardDeleteScheduledAccounts();

    expect(queue.add).toHaveBeenCalledWith(
      'delete_user_data',
      { userId: 'u1' },
      expect.objectContaining({ attempts: 3 }),
    );
    expect(mockCleanupWorker.hardDeleteUser).not.toHaveBeenCalled();
  });

  it('does nothing when no accounts are due', async () => {
    const { service, mockDb, mockCleanupWorker } = await build(null);
    mockDb.query.mockResolvedValueOnce([]);

    await service.hardDeleteScheduledAccounts();

    expect(mockCleanupWorker.hardDeleteUser).not.toHaveBeenCalled();
  });

  it('continues to the next account if one inline delete throws', async () => {
    const { service, mockDb, mockCleanupWorker } = await build(null);
    mockDb.query.mockResolvedValueOnce([
      { id: 'u1', deleted_at: daysAgo(31) },
      { id: 'u2', deleted_at: daysAgo(31) },
    ]);
    mockCleanupWorker.hardDeleteUser
      .mockRejectedValueOnce(new Error('db blip')) // u1 fails
      .mockResolvedValueOnce(undefined); // u2 succeeds

    await expect(service.hardDeleteScheduledAccounts()).resolves.toBeUndefined();
    expect(mockCleanupWorker.hardDeleteUser).toHaveBeenCalledTimes(2);
  });
});
