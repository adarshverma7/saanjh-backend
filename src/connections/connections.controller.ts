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
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { ConnectionsService, InviteListItem } from './connections.service';
import { CreateInviteDto } from './dto/create-invite.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { RenameConnectionDto } from './dto/rename-connection.dto';
import { ConnectDirectDto } from './dto/connect-direct.dto';
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

@ApiTags('Connections')
@Controller()
export class ConnectionsController {
  constructor(
    private readonly connectionsService: ConnectionsService,
    private readonly config: ConfigService,
  ) {}

  // ── Invite creation (JWT required) ─────────────────────────────────────────

  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Create invite', description: 'Creates a new invite. Returns a deep link + pre-filled WhatsApp message. Rate limited: 5/hour.' })
  @ApiResponse({ status: 201, description: 'Invite created with deep link' })
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

  @ApiOperation({ summary: 'Get invite details (public)', description: 'Returns invite details before sign-up. No auth required — used from the deep link landing page.' })
  @ApiParam({ name: 'code', description: 'Invite code from the deep link' })
  @Get('connections/invite/:code')
  getInviteDetails(@Param('code') code: string) {
    return this.connectionsService.getInviteDetails(code);
  }

  // ── Accept invite (JWT required) ───────────────────────────────────────────

  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Accept invite', description: 'Accepts a pending invite and creates the diary connection. Acceptor provides their own connection name.' })
  @ApiParam({ name: 'code', description: 'Invite code from the deep link' })
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

  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Connect directly', description: 'Creates a diary connection with an existing Saanjh user in one step. Returns existing connection if duplicate. Used by Discover screen.' })
  @Post('connections/connect-direct')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  connectDirect(
    @CurrentUser() user: RequestUser,
    @Body() dto: ConnectDirectDto,
  ) {
    const salt = this.config.get<string>('phoneHashSalt') ?? '';
    return this.connectionsService.connectDirect(
      user.id,
      dto.phone,
      dto.connection_name,
      dto.relationship_type,
      salt,
    );
  }

  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Check contacts', description: 'Checks which of the supplied phone numbers have Saanjh accounts. Numbers are hashed server-side — never stored.' })
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

  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'List connections', description: 'Returns all active diary connections with partner profile, streak data, and unread count.' })
  @Get('connections')
  @UseGuards(JwtAuthGuard)
  getConnections(@CurrentUser() user: RequestUser) {
    return this.connectionsService.getConnections(user.id);
  }

  // ── Single connection (member-gated) ───────────────────────────────────────

  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Get connection', description: 'Returns a single connection with full partner detail.' })
  @ApiParam({ name: 'id', description: 'Connection UUID' })
  @Get('connections/:id')
  @UseGuards(JwtAuthGuard, ConnectionMemberGuard)
  getConnection(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
  ) {
    return this.connectionsService.getConnection(user.id, connectionId);
  }

  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Get connection health', description: 'Returns streak, diary weather, and entry counts. Used by Memory Tree and diary contact cards.' })
  @ApiParam({ name: 'id', description: 'Connection UUID' })
  @Get('connections/:id/health')
  @UseGuards(JwtAuthGuard, ConnectionMemberGuard)
  getConnectionHealth(@Param('id') connectionId: string) {
    return this.connectionsService.getConnectionHealth(connectionId);
  }

  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Rename connection', description: 'Personal label — only affects this user\'s view of the connection.' })
  @ApiParam({ name: 'id', description: 'Connection UUID' })
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

  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Delete connection', description: 'Ends the diary connection for both users (soft delete — status becomes "ended" and it disappears from both users\' lists). Entries are retained server-side.' })
  @ApiParam({ name: 'id', description: 'Connection UUID' })
  @ApiResponse({ status: 200, description: 'Connection ended' })
  @ApiResponse({ status: 404, description: 'Connection not found or already ended' })
  @Delete('connections/:id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, ConnectionMemberGuard)
  async deleteConnection(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
  ): Promise<{ message: string }> {
    await this.connectionsService.endConnection(user.id, connectionId);
    return { message: 'Connection ended' };
  }

  // ── My invites ─────────────────────────────────────────────────────────────

  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'List my invites', description: 'Returns all invites sent by the current user. Used to show pending invite state ("Waiting for Maa…").' })
  @Get('invites')
  @UseGuards(JwtAuthGuard)
  getMyInvites(@CurrentUser() user: RequestUser): Promise<InviteListItem[]> {
    return this.connectionsService.getMyInvites(user.id);
  }

  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Cancel invite', description: 'Cancels a pending invite by its ID.' })
  @ApiParam({ name: 'id', description: 'Invite UUID' })
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
