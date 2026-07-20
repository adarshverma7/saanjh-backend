import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { StoriesService } from './stories.service';
import { RequestStoryUploadDto } from './dto/request-story-upload.dto';
import { ConfirmStoryDto } from './dto/confirm-story.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import type { RequestUser } from '../auth/strategies/jwt.strategy';

/**
 * Flicker Stories — Instagram-style 24-hour stories, visible to all of the
 * user's active diary partners (blocks respected). Media uses the same
 * two-step upload flow as diary entries.
 */
@ApiTags('Stories')
@ApiBearerAuth('JWT')
@Controller('stories')
@UseGuards(JwtAuthGuard)
export class StoriesController {
  constructor(private readonly storiesService: StoriesService) {}

  @ApiOperation({ summary: '[Step 1] Request story upload URL', description: 'Pre-creates a pending story and returns a 15-min presigned PUT URL for direct B2 upload. Then call /stories/confirm.' })
  @ApiResponse({ status: 200, description: '{ story_id, media_key, upload_url, expires_at }' })
  @Post('request-upload')
  @HttpCode(HttpStatus.OK)
  requestUpload(@CurrentUser() user: RequestUser, @Body() dto: RequestStoryUploadDto) {
    return this.storiesService.requestUpload(user.id, dto);
  }

  @ApiOperation({ summary: '[Step 2] Confirm story upload', description: 'Verifies the PUT succeeded and publishes the story for 24 hours. Partners receive SSE story_added.' })
  @ApiResponse({ status: 200, description: 'Published story object' })
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  confirmUpload(@CurrentUser() user: RequestUser, @Body() dto: ConfirmStoryDto) {
    return this.storiesService.confirmUpload(user.id, dto);
  }

  @ApiOperation({ summary: 'List active stories grouped by user', description: 'Own group first, then partners with unviewed stories, then fully-viewed. Each story carries a 1-hour signed media URL and viewed flag.' })
  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.storiesService.listGrouped(user.id);
  }

  @ApiOperation({ summary: 'Mark story as viewed', description: 'Records the flicker (view). Turns the ring green + heart for this viewer. Idempotent.' })
  @ApiParam({ name: 'storyId', description: 'Story UUID' })
  @Post(':storyId/view')
  @HttpCode(HttpStatus.OK)
  markViewed(@CurrentUser() user: RequestUser, @Param('storyId') storyId: string) {
    return this.storiesService.markViewed(user.id, storyId);
  }

  @ApiOperation({ summary: 'List story viewers', description: 'Author-only: who has flickered (viewed) this story, newest first.' })
  @ApiParam({ name: 'storyId', description: 'Story UUID' })
  @Get(':storyId/viewers')
  listViewers(@CurrentUser() user: RequestUser, @Param('storyId') storyId: string) {
    return this.storiesService.listViewers(user.id, storyId);
  }

  @ApiOperation({ summary: 'Delete own story', description: 'Author-only: tombstones the story and removes the media blob.' })
  @ApiParam({ name: 'storyId', description: 'Story UUID' })
  @Delete(':storyId')
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: RequestUser, @Param('storyId') storyId: string) {
    return this.storiesService.remove(user.id, storyId);
  }
}
