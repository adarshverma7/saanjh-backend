import { Injectable, NestMiddleware } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Request, Response, NextFunction } from 'express';

interface AuthenticatedRequest extends Request {
  user?: { id: string };
}

@Injectable()
export class ActivityMiddleware implements NestMiddleware {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  use(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
    const userId = req.user?.id;

    if (userId) {
      // Fire-and-forget — NEVER await.
      // This must not slow down or block any request.
      this.dataSource
        .query(
          `UPDATE users SET last_active_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
          [userId],
        )
        .catch(() => {
          // Silently discard — last_active_at is best-effort, non-critical
        });
    }

    next();
  }
}
