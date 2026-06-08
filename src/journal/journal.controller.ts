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
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
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
@ApiTags('Journal')
@ApiBearerAuth('JWT')
@Controller('journal')
@UseGuards(JwtAuthGuard)
export class JournalController {
  constructor(private readonly journalService: JournalService) {}

  @ApiOperation({ summary: '[Step 1] Request journal upload URL', description: 'Pre-creates a pending row and returns a 15-min presigned PUT URL for direct B2 upload.' })
  @Post('request-upload')
  @HttpCode(HttpStatus.OK)
  requestUpload(
    @CurrentUser() user: RequestUser,
    @Body('entry_type') entryType: 'voice' | 'video',
  ) {
    return this.journalService.requestUpload(user.id, entryType);
  }

  @ApiOperation({ summary: '[Step 2] Confirm journal upload', description: 'Verifies the B2 PUT succeeded and marks the journal entry as completed.' })
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  confirmUpload(
    @CurrentUser() user: RequestUser,
    @Body() dto: JournalConfirmUploadDto,
  ) {
    return this.journalService.confirmUpload(user.id, dto);
  }

  @ApiOperation({ summary: '[Legacy] Get journal upload URL', description: 'Old pre-signed URL endpoint. Use /request-upload + /confirm instead.' })
  @Post('upload-url')
  @HttpCode(HttpStatus.OK)
  getUploadUrl(
    @CurrentUser() user: RequestUser,
    @Body() dto: JournalUploadUrlDto,
  ) {
    return this.journalService.getUploadUrl(user.id, dto);
  }

  @ApiOperation({ summary: 'Create journal entry', description: 'Creates a text journal entry, or legacy voice/video with a media_key.' })
  @Post('entries')
  createEntry(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateJournalEntryDto,
  ) {
    return this.journalService.createEntry(user.id, dto);
  }

  @ApiOperation({ summary: 'List journal entries', description: 'Paginated list. No media URLs — call GET /entries/:id for a signed playback URL.' })
  @ApiQuery({ name: 'filter', required: false, enum: ['all', 'voice', 'video', 'text', 'starred'] })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @Get('entries')
  listEntries(
    @CurrentUser() user: RequestUser,
    @Query() dto: ListJournalDto,
  ) {
    return this.journalService.listEntries(user.id, dto);
  }

  @ApiOperation({ summary: 'Get journal entry', description: 'Returns the entry with a 1-hour signed media URL (if voice/video).' })
  @ApiParam({ name: 'id', description: 'Journal entry UUID' })
  @Get('entries/:id')
  getEntry(@CurrentUser() user: RequestUser, @Param('id') entryId: string) {
    return this.journalService.getEntry(user.id, entryId);
  }

  @ApiOperation({ summary: 'Star / unstar journal entry' })
  @ApiParam({ name: 'id', description: 'Journal entry UUID' })
  @Patch('entries/:id/star')
  @HttpCode(HttpStatus.OK)
  starEntry(
    @CurrentUser() user: RequestUser,
    @Param('id') entryId: string,
    @Body() dto: StarJournalDto,
  ) {
    return this.journalService.starEntry(user.id, entryId, dto.is_starred);
  }

  @ApiOperation({ summary: 'Delete journal entry', description: 'Soft-delete. Media retained in B2 for 90 days.' })
  @ApiParam({ name: 'id', description: 'Journal entry UUID' })
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
