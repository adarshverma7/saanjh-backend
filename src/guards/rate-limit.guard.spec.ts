import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { RateLimitGuard, RATE_LIMIT_KEY } from './rate-limit.guard';
import { TooManyRequestsException } from '../shared/exceptions/too-many-requests.exception';

function makeContext(
  meta: { maxRequests: number; windowSeconds: number; keyPrefix?: string } | undefined,
  userId?: string,
): ExecutionContext {
  const mockResponse = { setHeader: jest.fn() };
  const mockRequest = {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    method: 'POST',
    path: '/test',
    route: { path: '/test' },
    user: userId ? { sub: userId } : undefined,
  };

  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => mockRequest,
      getResponse: () => mockResponse,
    }),
  } as unknown as ExecutionContext;
}

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let mockDb: { query: jest.Mock };
  let mockReflector: { getAllAndOverride: jest.Mock };

  const META = { maxRequests: 3, windowSeconds: 600, keyPrefix: 'otp:send' };
  const USER_ID = 'user-abc-123';

  beforeEach(async () => {
    mockDb = { query: jest.fn() };
    mockReflector = { getAllAndOverride: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimitGuard,
        { provide: Reflector, useValue: mockReflector },
        { provide: getDataSourceToken(), useValue: mockDb },
      ],
    }).compile();

    guard = module.get<RateLimitGuard>(RateLimitGuard);
  });

  afterEach(() => jest.clearAllMocks());

  it('allows request when no rate limit metadata is set', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(undefined);
    const result = await guard.canActivate(makeContext(undefined));
    expect(result).toBe(true);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('allows request and creates new counter when no existing row', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(META);
    mockDb.query
      .mockResolvedValueOnce([])  // SELECT — no existing row
      .mockResolvedValueOnce([]); // INSERT/UPSERT

    const result = await guard.canActivate(makeContext(META, USER_ID));
    expect(result).toBe(true);

    const [upsertSql] = mockDb.query.mock.calls[1] as [string];
    expect(upsertSql).toContain('ON CONFLICT (key)');
  });

  it('allows request and increments counter within window', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(META);
    mockDb.query
      .mockResolvedValueOnce([{ count: 2, window_start: new Date() }]) // within window, count < max
      .mockResolvedValueOnce([]); // UPDATE count + 1

    const result = await guard.canActivate(makeContext(META, USER_ID));
    expect(result).toBe(true);

    const [updateSql] = mockDb.query.mock.calls[1] as [string];
    expect(updateSql).toContain('count = count + 1');
  });

  it('throws TooManyRequestsException when count >= maxRequests within window', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(META);
    mockDb.query.mockResolvedValueOnce([{ count: 3, window_start: new Date() }]); // at limit

    await expect(guard.canActivate(makeContext(META, USER_ID)))
      .rejects.toThrow(TooManyRequestsException);
  });

  it('resets counter when window has expired', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(META);
    const oldWindow = new Date(Date.now() - 700_000); // 700s ago, window is 600s
    mockDb.query
      .mockResolvedValueOnce([{ count: 99, window_start: oldWindow }]) // expired window
      .mockResolvedValueOnce([]); // UPSERT fresh window

    const result = await guard.canActivate(makeContext(META, USER_ID));
    expect(result).toBe(true);

    const [upsertSql] = mockDb.query.mock.calls[1] as [string];
    expect(upsertSql).toContain('count = 1');
  });

  it('uses IP address as identity when user is not authenticated', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(META);
    mockDb.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await guard.canActivate(makeContext(META)); // no userId

    const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toContain('127.0.0.1');
  });

  it('allows request through when DB fails (non-fatal)', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(META);
    mockDb.query.mockRejectedValueOnce(new Error('DB down'));

    const result = await guard.canActivate(makeContext(META, USER_ID));
    expect(result).toBe(true); // rate limit is non-fatal
  });
});
