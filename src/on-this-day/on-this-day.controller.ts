import {
  Controller,
  Get,
  Param,
  Query,
  Header,
  UseGuards,
} from '@nestjs/common';
import { OnThisDayService } from './on-this-day.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { ConnectionMemberGuard } from '../guards/connection-member.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import type { RequestUser } from '../auth/strategies/jwt.strategy';

@Controller('connections/:id/on-this-day')
@UseGuards(JwtAuthGuard, ConnectionMemberGuard)
export class OnThisDayController {
  constructor(private readonly onThisDayService: OnThisDayService) {}

  /**
   * GET /v1/connections/:id/on-this-day
   *
   * Returns diary entries recorded on the same calendar date (month + day)
   * in past years. Never includes entries from the current year.
   *
   * Query params:
   *   date  Optional 'YYYY-MM-DD'. Defaults to today in IST. Used for testing
   *         or navigating to a specific date. Most Flutter calls omit this.
   *
   * Cache-Control: 3600 s — entries from past years never change.
   * Flutter can cache this response for 1 hour without staling.
   */
  @Get()
  @Header('Cache-Control', 'private, max-age=3600')
  getOnThisDay(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Query('date') date?: string,
  ) {
    return this.onThisDayService.getOnThisDay(user.id, connectionId, date);
  }
}
