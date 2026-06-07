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
import { JournalService } from './journal.service';
import { JournalUploadUrlDto } from './dto/journal-upload-url.dto';
import { CreateJournalEntryDto } from './dto/create-journal-entry.dto';
import { ListJournalDto } from './dto/list-journal.dto';
import { StarJournalDto } from './dto/star-journal.dto';
import { JournalConfirmUploadDto } from './dto/journal-confirm-upload.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import type { RequestUser } from '../auth/strategies/jwt.strategy';

/**
 * Personal Journal — completely private, never shared with partner.
 *
 * IMPORTANT: ConnectionMemberGuard is intentionally NOT applied here.
 * Access control is enforced by user_id = $currentUserId inside every
 * service method. No connection ID is involved — this is a solo feature.
 *
 * Routes:
 *   POST   /v1/journal/upload-url       → pre-signed R2 URL for media
 *   POST   /v1/journal/entries          → create entry
 *   GET    /v1/journal/entries          → list entries (paginated)
 *   GET    /v1/journal/entries/:id      → single entry + signed media URL
 *   PATCH  /v1/journal/entries/:id/star → star / unstar
 *   DELETE /v1/journal/entries/:id      → soft delete
 */
@Controller('journal')
@UseGuards(JwtAuthGuard)
export class JournalController {
  constructor(private readonly journalService: JournalService) {}

  /**
   * POST /v1/journal/request-upload
   * Telegram-style step 1: pre-creates a pending row and returns a 15-min
   * presigned PUT URL. Flutter uploads directly to B2.
   */
  @Post('request-upload')
  @HttpCode(HttpStatus.OK)
  requestUpload(
    @CurrentUser() user: RequestUser,
    @Body('entry_type') entryType: 'voice' | 'video',
  ) {
    return this.journalService.requestUpload(user.id, entryType);
  }

  /**
   * POST /v1/journal/confirm
   * Telegram-style step 2: verifies the B2 upload and marks the entry completed.
   */
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  confirmUpload(
    @CurrentUser() user: RequestUser,
    @Body() dto: JournalConfirmUploadDto,
  ) {
    return this.journalService.confirmUpload(user.id, dto);
  }

  /**
   * POST /v1/journal/upload-url
   * Legacy pre-signed URL endpoint — kept for backward compatibility.
   */
  @Post('upload-url')
  @HttpCode(HttpStatus.OK)
  getUploadUrl(
    @CurrentUser() user: RequestUser,
    @Body() dto: JournalUploadUrlDto,
  ) {
    return this.journalService.getUploadUrl(user.id, dto);
  }

  /**
   * POST /v1/journal/entries
   * Creates a journal entry (text) or legacy voice/video via old flow.
   */
  @Post('entries')
  createEntry(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateJournalEntryDto,
  ) {
    return this.journalService.createEntry(user.id, dto);
  }

  /**
   * GET /v1/journal/entries
   * Paginated list of journal entries. No media URLs — call GET ./:id for playback.
   * Supports filter: all | voice | video | text | starred
   */
  @Get('entries')
  listEntries(
    @CurrentUser() user: RequestUser,
    @Query() dto: ListJournalDto,
  ) {
    return this.journalService.listEntries(user.id, dto);
  }

  /**
   * GET /v1/journal/entries/:id
   * Returns the entry with a 1-hour signed media URL (if applicable).
   */
  @Get('entries/:id')
  getEntry(@CurrentUser() user: RequestUser, @Param('id') entryId: string) {
    return this.journalService.getEntry(user.id, entryId);
  }

  /**
   * PATCH /v1/journal/entries/:id/star
   * Stars or unstars an entry.
   */
  @Patch('entries/:id/star')
  @HttpCode(HttpStatus.OK)
  starEntry(
    @CurrentUser() user: RequestUser,
    @Param('id') entryId: string,
    @Body() dto: StarJournalDto,
  ) {
    return this.journalService.starEntry(user.id, entryId, dto.is_starred);
  }

  /**
   * DELETE /v1/journal/entries/:id
   * Soft-deletes the entry. Media is retained in R2 for 90 days.
   * Personal memories are never immediately destroyed.
   */
  @Delete('entries/:id')
  @HttpCode(HttpStatus.OK)
  async deleteEntry(
    @CurrentUser() user: RequestUser,
    @Param('id') entryId: string,
  ): Promise<{ message: string }> {
    await this.journalService.deleteEntry(user.id, entryId);
    return { message: 'Entry removed' };
  }
}
