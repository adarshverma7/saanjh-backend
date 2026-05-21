import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom, take, toArray } from 'rxjs';
import { EventsService } from './events.service';

const USER_A = 'user-a';
const USER_B = 'user-b';
const CONN   = 'conn-1';

describe('EventsService', () => {
  let service: EventsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EventsService],
    }).compile();
    service = module.get<EventsService>(EventsService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getStream', () => {
    it('returns an Observable', () => {
      const stream$ = service.getStream(USER_A, CONN);
      expect(stream$).toBeDefined();
      expect(typeof stream$.subscribe).toBe('function');
    });

    it('different calls return separate streams', () => {
      const a$ = service.getStream(USER_A, CONN);
      const b$ = service.getStream(USER_B, CONN);
      expect(a$).not.toBe(b$);
    });
  });

  describe('push', () => {
    it('delivers pushed event to active subscriber', async () => {
      const stream$ = service.getStream(USER_A, CONN);

      // Collect one event then complete
      const receivedPromise = firstValueFrom(stream$.pipe(take(1)));

      // Push an event
      service.push(USER_A, CONN, {
        type: 'mutual_reveal',
        mutual_at: '2026-05-20T10:00:00Z',
      });

      const received = await receivedPromise;
      expect((received as { data: { type: string } }).data.type).toBe('mutual_reveal');
    });

    it('is a no-op when no subscriber exists for the key', () => {
      // Should not throw when there is no stream open
      expect(() =>
        service.push('unknown-user', 'unknown-conn', { type: 'heartbeat' }),
      ).not.toThrow();
    });

    it('delivers to all subscribers for the same key', async () => {
      const stream1$ = service.getStream(USER_A, CONN);
      const stream2$ = service.getStream(USER_A, CONN); // second SSE connection

      const p1 = firstValueFrom(stream1$.pipe(take(1)));
      const p2 = firstValueFrom(stream2$.pipe(take(1)));

      service.push(USER_A, CONN, { type: 'heartbeat' });

      const [e1, e2] = await Promise.all([p1, p2]);
      expect(e1).toBeDefined();
      expect(e2).toBeDefined();
    });
  });

  describe('broadcastToConnection', () => {
    it('pushes event to both users', async () => {
      const streamA$ = service.getStream(USER_A, CONN);
      const streamB$ = service.getStream(USER_B, CONN);

      const pA = firstValueFrom(streamA$.pipe(take(1)));
      const pB = firstValueFrom(streamB$.pipe(take(1)));

      service.broadcastToConnection(CONN, USER_A, USER_B, {
        type: 'mutual_reveal',
        mutual_at: '2026-05-20T10:00:00Z',
      });

      const [eA, eB] = await Promise.all([pA, pB]);
      expect((eA as { data: { type: string } }).data.type).toBe('mutual_reveal');
      expect((eB as { data: { type: string } }).data.type).toBe('mutual_reveal');
    });
  });

  describe('isOnline', () => {
    it('returns false when no stream is open', () => {
      expect(service.isOnline(USER_A, CONN)).toBe(false);
    });

    it('returns true when a stream is active', () => {
      const sub = service.getStream(USER_A, CONN).subscribe();
      expect(service.isOnline(USER_A, CONN)).toBe(true);
      sub.unsubscribe();
    });

    it('returns false after subscriber unsubscribes', (done) => {
      const sub = service.getStream(USER_A, CONN).subscribe();
      expect(service.isOnline(USER_A, CONN)).toBe(true);

      sub.unsubscribe();

      // Give finalize() a tick to run
      setImmediate(() => {
        expect(service.isOnline(USER_A, CONN)).toBe(false);
        done();
      });
    });
  });

  describe('activeStreamCount', () => {
    it('tracks count of active streams', () => {
      expect(service.activeStreamCount).toBe(0);

      const sub1 = service.getStream(USER_A, CONN).subscribe();
      expect(service.activeStreamCount).toBe(1);

      const sub2 = service.getStream(USER_B, CONN).subscribe();
      expect(service.activeStreamCount).toBe(2);

      sub1.unsubscribe();
      setImmediate(() => {
        // After finalize runs
      });
      sub2.unsubscribe();
    });
  });
});
