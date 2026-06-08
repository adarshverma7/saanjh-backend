import {
  Controller,
  Get,
  Param,
  Query,
  Header,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { MemoryTreeService } from './memory-tree.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { ConnectionMemberGuard } from '../guards/connection-member.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import type { RequestUser } from '../auth/strategies/jwt.strategy';

/**
 * Routes:
 *   GET /v1/connections/:id/memory-tree            → full tree with cache (10 min TTL)
 *   GET /v1/connections/:id/memory-tree/:yearMonth → month detail (live, no cache)
 */
@ApiTags('Memory Tree')
@ApiBearerAuth('JWT')
@ApiParam({ name: 'id', description: 'Connection UUID' })
@Controller('connections/:id/memory-tree')
@UseGuards(JwtAuthGuard, ConnectionMemberGuard)
export class MemoryTreeController {
  constructor(private readonly memoryTreeService: MemoryTreeService) {}

  /**
   * GET /v1/connections/:id/memory-tree
   *
   * Returns the full Memory Tree data for the connection:
   *  - All months with entry counts, mood distribution, node health
   *  - Overall tree health (recency-weighted)
   *  - Streak count and diary weather (always fresh)
   *  - Milestone markers per month
   *
   * Cache-Control: 600 s (10 minutes) — matches server-side cache TTL.
   * Flutter should honour this to avoid unnecessary API calls.
   */
  @ApiOperation({ summary: 'Get full memory tree', description: 'Returns all months with entry counts, mood distribution, tree health, streak, and milestones. Cached 10 min.' })
  @Get()
  @Header('Cache-Control', 'private, max-age=600')
  getMemoryTree(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
  ) {
    return this.memoryTreeService.getMemoryTree(user.id, connectionId);
  }

  /**
   * GET /v1/connections/:id/memory-tree/:yearMonth
   *
   * Returns live (non-cached) data for a specific month:
   *  - All diary entries for that month (ordered by recorded_at DESC)
   *  - Month stats: entry count, type breakdown, mood distribution, node health
   *  - Whether a streak milestone was achieved that month
   *
   * Supports filter query param: all | voice | video | starred
   *
   * Used by the Memory Tree month detail sheet in Flutter.
   */
  @ApiOperation({ summary: 'Get month detail', description: 'Returns live (non-cached) entries and stats for a specific month (YYYY-MM). Supports filter query.' })
  @ApiParam({ name: 'yearMonth', description: 'Month in YYYY-MM format, e.g. 2026-05' })
  @ApiQuery({ name: 'filter', required: false, enum: ['all', 'voice', 'video', 'starred'] })
  @Get(':yearMonth')
  getMonthDetail(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Param('yearMonth') yearMonth: string,
    @Query('filter') filter?: string,
  ) {
    return this.memoryTreeService.getMonthDetail(
      user.id,
      connectionId,
      yearMonth,
      filter ?? 'all',
    );
  }
}
