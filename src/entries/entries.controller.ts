import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger';
import { EntriesService } from './entries.service';
import { RateLimitGuard, RateLimit } from '../guards/rate-limit.guard';
import { UploadUrlDto } from './dto/upload-url.dto';
import { CreateEntryDto } from './dto/create-entry.dto';
import { ListEntriesDto } from './dto/list-entries.dto';
import { StarEntryDto } from './dto/star-entry.dto';
import { RequestUploadDto } from './dto/request-upload.dto';
import { ConfirmUploadDto } from './dto/confirm-upload.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { ConnectionMemberGuard } from '../guards/connection-member.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import type { RequestUser } from '../auth/strategies/jwt.strategy';

/**
 * All endpoints nested under /v1/connections/:id/entries.
 * ConnectionMemberGuard verifies user is user_a or user_b before every action.
 */
@ApiTags('Diary Entries')
@ApiBearerAuth('JWT')
@ApiParam({ name: 'id', description: 'Connection UUID' })
@Controller('connections/:id/entries')
@UseGuards(JwtAuthGuard, ConnectionMemberGuard)
export class EntriesController {
  constructor(private readonly entriesService: EntriesService) {}

  @ApiOperation({ summary: '[Step 1] Request upload URL', description: 'Telegram-style: pre-creates a pending DB row and returns a 15-min presigned PUT URL. Flutter uploads binary directly to B2, then calls /confirm.' })
  @ApiResponse({ status: 200, description: '{ entry_id, media_key, upload_url, expires_at }' })
  @Post('request-upload')
  @HttpCode(HttpStatus.OK)
  requestUpload(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Body() dto: RequestUploadDto,
  ) {
    return this.entriesService.requestUpload(user.id, connectionId, dto);
  }

  @ApiOperation({ summary: '[Step 2] Confirm upload', description: 'Verifies the B2 PUT succeeded, marks entry completed, pushes SSE new_entry event with signed URL to partner.' })
  @ApiResponse({ status: 200, description: 'Completed diary entry object' })
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  confirmUpload(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.entriesService.confirmUpload(user.id, connectionId, dto);
  }

  @ApiOperation({ summary: '[Legacy] Get upload URL', description: 'Old pre-signed URL endpoint. Use /request-upload + /confirm instead.' })
  @Post('upload-url')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(30, 3600, 'entries:upload-url')
  getUploadUrl(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Body() dto: UploadUrlDto,
  ) {
    return this.entriesService.getUploadUrl(user.id, connectionId, dto);
  }

  @ApiOperation({ summary: 'Create text entry (or legacy media)', description: 'Creates a text entry inline, or legacy voice/video using the old two-step flow with a media_key.' })
  @Post()
  createEntry(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Body() dto: CreateEntryDto,
  ) {
    return this.entriesService.createEntry(user.id, connectionId, dto);
  }

  @ApiOperation({ summary: 'List diary entries', description: 'Paginated diary thread — metadata only, no signed URLs. Call GET …/:entryId to get a playback URL.' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Pagination cursor from previous response' })
  @ApiQuery({ name: 'filter', required: false, enum: ['all', 'voice', 'video', 'starred'], description: 'Entry type filter' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size (default 20)' })
  @Get()
  listEntries(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Query() dto: ListEntriesDto,
  ) {
    return this.entriesService.listEntries(user.id, connectionId, dto);
  }

  @ApiOperation({ summary: 'Get entry with media URL', description: 'Returns entry with a 1-hour signed media URL. Entries older than 24 h return is_expired:true and no media_url.' })
  @ApiParam({ name: 'entryId', description: 'Entry UUID' })
  @Get(':entryId')
  getEntry(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Param('entryId') entryId: string,
  ) {
    return this.entriesService.getEntry(user.id, connectionId, entryId);
  }

  @ApiOperation({ summary: 'Get entry for Memory Tree', description: 'Same as GET /:entryId but bypasses the 24 h expiry — always returns a playback URL. Used exclusively by Memory Tree.' })
  @ApiParam({ name: 'entryId', description: 'Entry UUID' })
  @Get(':entryId/moments')
  getEntryForMoments(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Param('entryId') entryId: string,
  ) {
    return this.entriesService.getEntryForMoments(user.id, connectionId, entryId);
  }

  @ApiOperation({ summary: 'Star / unstar entry', description: 'Stars or unstars an entry for the Memory Jar.' })
  @ApiParam({ name: 'entryId', description: 'Entry UUID' })
  @Patch(':entryId/star')
  @HttpCode(HttpStatus.OK)
  starEntry(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Param('entryId') entryId: string,
    @Body() dto: StarEntryDto,
  ) {
    return this.entriesService.starEntry(
      user.id,
      connectionId,
      entryId,
      dto.is_starred,
    );
  }

  @ApiOperation({ summary: 'Save text to Memory Tree', description: 'Marks a text message as saved to the Memory Tree. Voice/video appear automatically; text only appears when explicitly saved.' })
  @ApiParam({ name: 'entryId', description: 'Entry UUID' })
  @Patch(':entryId/save-to-moments')
  @HttpCode(HttpStatus.OK)
  saveToMoments(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Param('entryId') entryId: string,
  ) {
    return this.entriesService.saveToMoments(user.id, connectionId, entryId);
  }

  @ApiOperation({ summary: 'Remove text from Memory Tree', description: 'Removes a text message from the Memory Tree (sets saved_to_moments = false).' })
  @ApiParam({ name: 'entryId', description: 'Entry UUID' })
  @Delete(':entryId/save-to-moments')
  @HttpCode(HttpStatus.OK)
  removeFromMoments(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Param('entryId') entryId: string,
  ) {
    return this.entriesService.removeFromMoments(user.id, connectionId, entryId);
  }

  @ApiOperation({ summary: 'Delete entry', description: 'Soft-delete only — media retained in B2 for 90 days. Only the original author can delete.' })
  @ApiParam({ name: 'entryId', description: 'Entry UUID' })
  @Delete(':entryId')
  @HttpCode(HttpStatus.OK)
  async softDeleteEntry(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Param('entryId') entryId: string,
  ): Promise<{ message: string }> {
    await this.entriesService.softDeleteEntry(user.id, connectionId, entryId);
    return { message: 'Entry removed' };
  }

  @ApiOperation({ summary: 'Mark entry as played', description: 'Increments play_count — marks the entry as listened to. Used for unread_count calculation on the connections list.' })
  @ApiParam({ name: 'entryId', description: 'Entry UUID' })
  @Patch(':entryId/played')
  @HttpCode(HttpStatus.OK)
  recordPlay(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Param('entryId') entryId: string,
  ) {
    return this.entriesService.recordPlay(user.id, connectionId, entryId);
  }
}
