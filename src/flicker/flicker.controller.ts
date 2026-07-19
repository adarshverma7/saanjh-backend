import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Sse,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { FlickerService } from './flicker.service';
import { EventsService } from './events.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RateLimitGuard, RateLimit } from '../guards/rate-limit.guard';
import { ConnectionMemberGuard } from '../guards/connection-member.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import type { RequestUser } from '../auth/strategies/jwt.strategy';

/**
 * All routes are nested under /v1/connections/:id/
 * ConnectionMemberGuard verifies user is user_a or user_b before every action.
 *
 * Route summary:
 *   GET  connections/:id/events         — SSE stream (keep-alive, real-time)
 *   POST connections/:id/flicker        — send a Flicker
 *   GET  connections/:id/flicker/latest — current flicker status
 *   GET  connections/:id/flicker/history — paginated flicker history
 */
@ApiTags('Flicker & Events')
@ApiBearerAuth('JWT')
@ApiParam({ name: 'id', description: 'Connection UUID' })
@Controller('connections')
export class FlickerController {
  constructor(
    private readonly flickerService: FlickerService,
    private readonly eventsService: EventsService,
  ) {}

  // ── SSE Stream ─────────────────────────────────────────────────────────────

  /**
   * GET /v1/connections/:id/events
   * Opens a persistent Server-Sent Events stream for the given connection.
   *
   * Event types delivered in real-time:
   *   flicker_received  — partner sent a Flicker to this user
   *   mutual_reveal     — both users Flickered within 5 minutes of each other
   *   new_entry         — partner posted a voice/video entry
   *   transcription_ready — a voice entry has been transcribed
   *   heartbeat         — sent every 25 s to keep proxies alive
   *
   * Flutter uses the EventSource package or http streaming to subscribe.
   * SSE auto-reconnects if the connection drops.
   */
  @ApiOperation({ summary: 'SSE event stream', description: 'Opens a persistent Server-Sent Events stream. Event types: flicker_received, mutual_reveal, new_entry, transcription_ready, heartbeat (every 25 s).' })
  @ApiResponse({ status: 200, description: 'text/event-stream — keep-alive SSE stream' })
  @Sse(':id/events')
  @UseGuards(JwtAuthGuard, ConnectionMemberGuard)
  liveEvents(
    @Param('id') connectionId: string,
    @CurrentUser() user: RequestUser,
  ): Observable<MessageEvent> {
    return this.eventsService.getStream(user.id, connectionId);
  }

  // ── Send Flicker ───────────────────────────────────────────────────────────

  /**
   * POST /v1/connections/:id/flicker
   * Sends a presence signal (Flicker) to the partner.
   *
   * If the partner also sent a Flicker within the last 5 minutes:
   *   → marks both as mutual, pushes mutual_reveal SSE to both, notifies both via FCM
   * Otherwise:
   *   → pushes flicker_received SSE to partner, notifies partner via FCM
   *
   * Rate limited: 10 per user per connection per hour.
   */
  @ApiOperation({ summary: 'Send Flicker', description: 'Sends a presence signal. If partner also flickered within 5 min → mutual_reveal SSE to both. Rate limited: 10/hour.' })
  @Post(':id/flicker')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, ConnectionMemberGuard, RateLimitGuard)
  @RateLimit(10, 3600, 'flicker:send')
  sendFlicker(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
  ) {
    return this.flickerService.sendFlicker(user.id, connectionId);
  }

  @ApiOperation({ summary: 'Recording indicator', description: 'Ephemeral "capturing a memory" signal pushed to the partner over SSE. Not stored.' })
  @Post(':id/recording')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, ConnectionMemberGuard)
  async signalRecording(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Body() body: { is_recording?: boolean; entry_type?: string },
  ) {
    await this.flickerService.signalRecording(
      user.id,
      connectionId,
      body.is_recording === true,
      typeof body.entry_type === 'string' ? body.entry_type : 'voice',
    );
    return { message: 'ok' };
  }

  // ── Flicker Status ─────────────────────────────────────────────────────────

  /**
   * GET /v1/connections/:id/flicker/latest
   * Returns the current flicker state for this connection:
   *   - When I last flickered
   *   - When partner last flickered
   *   - Whether there's an active mutual reveal
   *   - When the current mutual window closes
   *
   * Cached for 30 s in memory — safe to poll from Flutter Pulse screen.
   */
  @ApiOperation({ summary: 'Get flicker status', description: 'Returns current flicker state: last sent/received times, active mutual reveal, window close time. Cached 30 s.' })
  @Get(':id/flicker/latest')
  @UseGuards(JwtAuthGuard, ConnectionMemberGuard)
  getFlickerStatus(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
  ) {
    return this.flickerService.getFlickerStatus(user.id, connectionId);
  }

  // ── Flicker History ────────────────────────────────────────────────────────

  /**
   * GET /v1/connections/:id/flicker/history
   * Returns paginated history of flickers for this connection (sent and received).
   */
  @ApiOperation({ summary: 'Get flicker history', description: 'Paginated history of flickers sent and received for this connection.' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size (max 100, default 30)' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Pagination cursor' })
  @Get(':id/flicker/history')
  @UseGuards(JwtAuthGuard, ConnectionMemberGuard)
  getFlickerHistory(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const parsedLimit = Math.min(parseInt(limit ?? '30', 10) || 30, 100);
    return this.flickerService.getFlickerHistory(
      user.id,
      connectionId,
      parsedLimit,
      cursor,
    );
  }
}
