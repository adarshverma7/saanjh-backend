import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Request } from 'express';

interface AuthenticatedRequest extends Request {
  user?: { id: string };
}

/**
 * Core privacy boundary for Saanjh.
 *
 * Verifies the requesting user is user_a OR user_b of the target connection.
 * This guard MUST be applied to every endpoint that touches diary entries,
 * flicker events, memory tree, occasions, and memory jar.
 *
 * Apply with: @UseGuards(JwtAuthGuard, ConnectionMemberGuard)
 * The connection UUID must be in request.params.id.
 */
@Injectable()
export class ConnectionMemberGuard implements CanActivate {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const connectionId = request.params['id'];
    const userId = request.user?.id;

    if (!connectionId || !userId) {
      throw new ForbiddenException({
        error: 'NOT_CONNECTION_MEMBER',
        message: 'Connection ID or user identity missing',
      });
    }

    const result = await this.dataSource.query<unknown[]>(
      `SELECT 1
       FROM diary_connections
       WHERE id = $1
         AND status = 'active'
         AND (user_a_id = $2 OR user_b_id = $2)
       LIMIT 1`,
      [connectionId, userId],
    );

    if (!result.length) {
      throw new ForbiddenException({
        error: 'NOT_CONNECTION_MEMBER',
        message: 'You are not a member of this connection',
      });
    }

    return true;
  }
}
