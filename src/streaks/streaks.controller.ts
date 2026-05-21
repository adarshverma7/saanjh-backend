import {
  Controller,
  Get,
  Post,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { StreaksService } from './streaks.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { ConnectionMemberGuard } from '../guards/connection-member.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import type { RequestUser } from '../auth/strategies/jwt.strategy';

/**
 * Routes:
 *   GET  /v1/connections/:id/streak                    → full streak data
 *   POST /v1/connections/:id/milestones/:days/seen     → mark celebration seen
 */
@Controller('connections/:id')
@UseGuards(JwtAuthGuard, ConnectionMemberGuard)
export class StreaksController {
  constructor(private readonly streaksService: StreaksService) {}

  /**
   * GET /v1/connections/:id/streak
   *
   * Returns current streak state for the connection:
   *  - current_streak, longest_streak, streak_started_at
   *  - days_since_last_entry (null if no entries yet)
   *  - at_risk: true if streak > 0 and no entry posted today (IST)
   *  - total_entry_days: distinct IST calendar days with any entry
   *  - milestones: achieved milestone days + seen_by_me flag
   *
   * Flutter uses this to drive the streak display and milestone celebrations.
   */
  @Get('streak')
  getStreakData(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
  ) {
    return this.streaksService.getStreakData(user.id, connectionId);
  }

  /**
   * POST /v1/connections/:id/milestones/:days/seen
   *
   * Marks the milestone celebration as seen by the current user.
   * Prevents the celebration screen from reappearing on every app open.
   * Both users see the celebration independently — each must call this.
   */
  @Post('milestones/:days/seen')
  @HttpCode(HttpStatus.OK)
  async markMilestoneSeen(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Param('days') days: string,
  ): Promise<{ message: string }> {
    await this.streaksService.markMilestoneSeen(
      user.id,
      connectionId,
      parseInt(days, 10),
    );
    return { message: 'Milestone marked as seen' };
  }
}
