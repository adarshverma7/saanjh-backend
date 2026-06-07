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
@Controller('connections/:id/entries')
@UseGuards(JwtAuthGuard, ConnectionMemberGuard)
export class EntriesController {
  constructor(private readonly entriesService: EntriesService) {}

  /**
   * POST /v1/connections/:id/entries/request-upload
   * Telegram-style step 1: pre-creates a pending DB row and returns a 15-min
   * presigned PUT URL. Flutter uploads binary directly to B2.
   */
  @Post('request-upload')
  @HttpCode(HttpStatus.OK)
  requestUpload(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Body() dto: RequestUploadDto,
  ) {
    return this.entriesService.requestUpload(user.id, connectionId, dto);
  }

  /**
   * POST /v1/connections/:id/entries/confirm
   * Telegram-style step 2: verifies the B2 upload, marks entry completed,
   * and pushes an SSE new_entry event with a signed URL to the partner.
   */
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  confirmUpload(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.entriesService.confirmUpload(user.id, connectionId, dto);
  }

  /**
   * POST /v1/connections/:id/entries/upload-url
   * Legacy pre-signed URL endpoint — kept for backward compatibility.
   */
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

  /**
   * POST /v1/connections/:id/entries
   * Creates a text entry, or legacy voice/video via the old two-step flow.
   */
  @Post()
  createEntry(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Body() dto: CreateEntryDto,
  ) {
    return this.entriesService.createEntry(user.id, connectionId, dto);
  }

  /**
   * GET /v1/connections/:id/entries
   * Paginated diary thread — metadata only, no signed URLs.
   * Client calls GET .../entries/:entryId when ready to play.
   */
  @Get()
  listEntries(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Query() dto: ListEntriesDto,
  ) {
    return this.entriesService.listEntries(user.id, connectionId, dto);
  }

  /**
   * GET /v1/connections/:id/entries/:entryId
   * Returns entry with 1-hour signed media URL for playback.
   * Expired entries (>24h) return is_expired:true and no media_url.
   */
  @Get(':entryId')
  getEntry(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Param('entryId') entryId: string,
  ) {
    return this.entriesService.getEntry(user.id, connectionId, entryId);
  }

  /**
   * GET /v1/connections/:id/entries/:entryId/moments
   * Same as getEntry but bypasses the 24-hour diary expiry.
   * Used exclusively by the Memory Tree to play old moments.
   */
  @Get(':entryId/moments')
  getEntryForMoments(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Param('entryId') entryId: string,
  ) {
    return this.entriesService.getEntryForMoments(user.id, connectionId, entryId);
  }

  /**
   * PATCH /v1/connections/:id/entries/:entryId/star
   * Stars or unstars an entry for the Memory Jar.
   */
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

  /**
   * PATCH /v1/connections/:id/entries/:entryId/save-to-moments
   * Marks a text message as intentionally saved to the Memory Tree.
   * Audio/video entries appear automatically; text only appears when explicitly saved.
   */
  @Patch(':entryId/save-to-moments')
  @HttpCode(HttpStatus.OK)
  saveToMoments(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Param('entryId') entryId: string,
  ) {
    return this.entriesService.saveToMoments(user.id, connectionId, entryId);
  }

  /**
   * DELETE /v1/connections/:id/entries/:entryId/save-to-moments
   * Removes a text message from the Memory Tree (sets saved_to_moments = false).
   */
  @Delete(':entryId/save-to-moments')
  @HttpCode(HttpStatus.OK)
  removeFromMoments(
    @CurrentUser() user: RequestUser,
    @Param('id') connectionId: string,
    @Param('entryId') entryId: string,
  ) {
    return this.entriesService.removeFromMoments(user.id, connectionId, entryId);
  }

  /**
   * DELETE /v1/connections/:id/entries/:entryId
   * Soft-deletes only — media retained in R2 for 90 days.
   * Only the author can delete. Voice memories are never immediately destroyed.
   */
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

  /**
   * PATCH /v1/connections/:id/entries/:entryId/played
   * Increments play_count — marks entry as "listened to".
   * Used for unread_count calculation on the connections list.
   */
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
