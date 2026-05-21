import {
  Controller,
  Get,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { MemoryJarService } from './memory-jar.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { ConnectionMemberGuard } from '../guards/connection-member.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import type { RequestUser } from '../auth/strategies/jwt.strategy';

/**
 * Routes:
 *   GET /v1/connections/:id/memory-jar/surface  — time-gated random star
 *   GET /v1/connections/:id/memory-jar          — all starred, paginated
 */
@Controller('connections/:id/memory-jar')
@UseGuards(JwtAuthGuard, ConnectionMemberGuard)
export class MemoryJarController {
  constructor(private readonly memoryJarService: MemoryJarService) {}

  /**
   * GET /v1/connections/:id/memory-jar/surface
   *
   * Surfaces one random starred memory on home screen open.
   * Time-gated: returns { surfaced: false } if called within 4 hours of the
   * last surface. Flutter should check surfaced before showing the overlay.
   *
   * Response always includes total_starred so Flutter can show the star count
   * even when no memory is surfaced.
   */
  @Get('surface')
  @HttpCode(HttpStatus.OK)
  surfaceMemory(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
  ) {
    return this.memoryJarService.surfaceMemory(user.id, connectionId);
  }

  /**
   * GET /v1/connections/:id/memory-jar
   *
   * Returns all starred entries in reverse-star order (most recently starred first).
   * Used by the "View all memories" screen.
   *
   * Query params:
   *   limit   Max entries per page (default 20, max 50)
   *   cursor  Opaque pagination cursor from previous response
   */
  @Get()
  getAllStarred(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const parsedLimit = Math.min(parseInt(limit ?? '20', 10) || 20, 50);
    return this.memoryJarService.getAllStarred(
      user.id,
      connectionId,
      parsedLimit,
      cursor,
    );
  }
}
