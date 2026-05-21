import {
  Injectable,
  CanActivate,
  ExecutionContext,
  SetMetadata,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Request, Response } from 'express';
import { TooManyRequestsException } from '../shared/exceptions/too-many-requests.exception';

interface RateLimitMeta {
  maxRequests: number;
  windowSeconds: number;
  keyPrefix?: string;
}

export const RATE_LIMIT_KEY = 'rate_limit';

export function RateLimit(
  maxRequests: number,
  windowSeconds: number,
  keyPrefix?: string,
): MethodDecorator & ClassDecorator {
  return SetMetadata(RATE_LIMIT_KEY, { maxRequests, windowSeconds, keyPrefix });
}

interface CounterRow {
  count: number;
  window_start: Date;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @InjectDataSource() private readonly db: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<RateLimitMeta | undefined>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!meta) return true; // No rate limit configured for this route

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const userId = (req as Request & { user?: { sub: string } }).user?.sub;
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const routeKey = meta.keyPrefix ?? `${req.method}:${req.route?.path ?? req.path}`;
    const identity = userId ?? ip;
    const key = `${routeKey}:${identity}`;

    try {
      const rows = await this.db.query<CounterRow[]>(
        `SELECT count, window_start FROM rate_limit_counters WHERE key = $1`,
        [key],
      );

      const now = new Date();

      if (rows.length) {
        const { count, window_start } = rows[0];
        const windowAge = (now.getTime() - new Date(window_start).getTime()) / 1000;

        if (windowAge <= meta.windowSeconds) {
          // Within the current window
          if (count >= meta.maxRequests) {
            const retryAfter = Math.ceil(meta.windowSeconds - windowAge);
            res.setHeader('Retry-After', String(retryAfter));
            throw new TooManyRequestsException({
              error: 'RATE_LIMIT_EXCEEDED',
              message: `Too many requests. Retry after ${retryAfter} seconds.`,
            });
          }
          // Increment counter
          await this.db.query(
            `UPDATE rate_limit_counters SET count = count + 1 WHERE key = $1`,
            [key],
          );
          return true;
        }
      }

      // No row or window expired — upsert fresh window
      await this.db.query(
        `INSERT INTO rate_limit_counters (key, count, window_start)
         VALUES ($1, 1, NOW())
         ON CONFLICT (key) DO UPDATE SET count = 1, window_start = NOW()`,
        [key],
      );
    } catch (err: unknown) {
      if (err instanceof TooManyRequestsException) throw err;
      // Rate limit DB failure is non-fatal — allow request through
      this.logger.warn(`Rate limit check failed for key=${key}`, err);
    }

    return true;
  }
}
