import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionsService, InviteListItem } from './connections.service';
import { CreateInviteDto } from './dto/create-invite.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { RenameConnectionDto } from './dto/rename-connection.dto';
import { IsArray, IsString, ArrayMaxSize } from 'class-validator';

class CheckContactsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  phones: string[];
}
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { ConnectionMemberGuard } from '../guards/connection-member.guard';
import { RateLimitGuard, RateLimit } from '../guards/rate-limit.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import type { RequestUser } from '../auth/strategies/jwt.strategy';

@Controller()
export class ConnectionsController {
  constructor(
    private readonly connectionsService: ConnectionsService,
    private readonly config: ConfigService,
  ) {}

  // ── Invite creation (JWT required) ─────────────────────────────────────────

  /**
   * POST /v1/connections/invite
   * Creates a new invite for a specific person.
   * Returns a deep link + pre-filled WhatsApp message.
   */
  @Post('connections/invite')
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit(5, 3600, 'connections:invite')
  createInvite(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateInviteDto,
  ) {
    const salt = this.config.get<string>('phoneHashSalt') ?? '';
    return this.connectionsService.createInvite(user.id, dto, salt);
  }

  // ── Invite details (public — used before signup) ───────────────────────────

  /**
   * GET /v1/connections/invite/:code
   * Returns invite details for the invited user to see before signing up.
   * No auth required — used from the deep link landing page.
   */
  @Get('connections/invite/:code')
  getInviteDetails(@Param('code') code: string) {
    return this.connectionsService.getInviteDetails(code);
  }

  // ── Accept invite (JWT required) ───────────────────────────────────────────

  /**
   * POST /v1/connections/invite/:code/accept
   * Accepts a pending invite and creates the diary connection.
   * The acceptor provides their own name for the connection.
   */
  @Post('connections/invite/:code/accept')
  @UseGuards(JwtAuthGuard)
  acceptInvite(
    @CurrentUser() user: RequestUser,
    @Param('code') code: string,
    @Body() dto: AcceptInviteDto,
  ) {
    return this.connectionsService.acceptInvite(
      user.id,
      code,
      dto.connection_name,
    );
  }

  // ── List connections ───────────────────────────────────────────────────────

  /**
   * POST /v1/connections/check-contacts
   * Checks which phone numbers in the user's contacts have Saanjh accounts.
   * Phone numbers are hashed server-side — never stored or logged.
   */
  @Post('connections/check-contacts')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  checkContacts(
    @CurrentUser() user: RequestUser,
    @Body() dto: CheckContactsDto,
  ) {
    const salt = this.config.get<string>('phoneHashSalt') ?? '';
    return this.connectionsService.checkContacts(user.id, dto.phones, salt);
  }

  /**
   * GET /v1/connections
   * Returns all active diary connections for the current user.
   * Includes partner profile, streak, unread count per connection.
   */
  @Get('connections')
  @UseGuards(JwtAuthGuard)
  getConnections(@CurrentUser() user: RequestUser) {
    return this.connectionsService.getConnections(user.id);
  }

  // ── Single connection (member-gated) ───────────────────────────────────────

  /**
   * GET /v1/connections/:id
   * Returns a single connection with full partner detail.
   */
  @Get('connections/:id')
  @UseGuards(JwtAuthGuard, ConnectionMemberGuard)
  getConnection(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
  ) {
    return this.connectionsService.getConnection(user.id, connectionId);
  }

  /**
   * GET /v1/connections/:id/health
   * Returns streak, diary weather, entry counts for the connection.
   * Used by Memory Tree and diary contact cards.
   */
  @Get('connections/:id/health')
  @UseGuards(JwtAuthGuard, ConnectionMemberGuard)
  getConnectionHealth(@Param('id') connectionId: string) {
    return this.connectionsService.getConnectionHealth(connectionId);
  }

  /**
   * PATCH /v1/connections/:id/name
   * Renames the connection (personal label — only affects this user's view).
   */
  @Patch('connections/:id/name')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, ConnectionMemberGuard)
  async renameConnection(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Body() dto: RenameConnectionDto,
  ): Promise<{ message: string }> {
    await this.connectionsService.renameConnection(
      user.id,
      connectionId,
      dto.name,
    );
    return { message: 'Connection renamed' };
  }

  // ── My invites ─────────────────────────────────────────────────────────────

  /**
   * GET /v1/invites
   * Returns all invites sent by the current user.
   * Used to show "Waiting for Maa..." pending invite state.
   */
  @Get('invites')
  @UseGuards(JwtAuthGuard)
  getMyInvites(@CurrentUser() user: RequestUser): Promise<InviteListItem[]> {
    return this.connectionsService.getMyInvites(user.id);
  }

  /**
   * DELETE /v1/invites/:id
   * Cancels a pending invite.
   */
  @Delete('invites/:id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async cancelInvite(
    @CurrentUser() user: RequestUser,
    @Param('id') inviteId: string,
  ): Promise<{ message: string }> {
    await this.connectionsService.cancelInvite(user.id, inviteId);
    return { message: 'Invite cancelled' };
  }
}
