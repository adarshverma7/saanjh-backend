import {
  Controller,
  Get,
  Put,
  Post,
  Patch,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateAvatarDto } from './dto/update-avatar.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import type { RequestUser } from '../auth/strategies/jwt.strategy';

/**
 * Handles two logical groups:
 *   /v1/onboarding/* — profile setup steps shown to new users
 *   /v1/settings/*   — post-onboarding app preferences
 *
 * ActivityMiddleware runs on every request here, updating last_active_at.
 */
@ApiBearerAuth('JWT')
@Controller()
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ── Onboarding ─────────────────────────────────────────────────────────────

  @ApiTags('Onboarding & Profile')
  @ApiOperation({ summary: 'Get onboarding status', description: 'Returns which onboarding step the user is on. Flutter checks this on app start.' })
  @ApiResponse({ status: 200, description: 'Onboarding step info' })
  @Get('onboarding/status')
  getOnboardingStatus(@CurrentUser() user: RequestUser) {
    return this.usersService.getOnboardingStatus(user.id);
  }

  @ApiTags('Onboarding & Profile')
  @ApiOperation({ summary: 'Update profile', description: 'Sets display name, language, date of birth, timezone. Idempotent — replaces previous values.' })
  @Put('onboarding/profile')
  updateProfile(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(user.id, dto);
  }

  @ApiTags('Onboarding & Profile')
  @ApiOperation({ summary: 'Get avatar upload URL', description: 'Returns a pre-signed B2 URL for direct avatar upload. Upload to upload_url then call PATCH /onboarding/avatar.' })
  @Post('onboarding/avatar/upload-url')
  @HttpCode(HttpStatus.OK)
  getAvatarUploadUrl(@CurrentUser() user: RequestUser) {
    return this.usersService.getAvatarUploadUrl(user.id);
  }

  @ApiTags('Onboarding & Profile')
  @ApiOperation({ summary: 'Confirm avatar upload', description: 'Confirms the avatar PUT to B2 completed and sets users.avatar_key. Deletes the previous avatar.' })
  @Patch('onboarding/avatar')
  updateAvatar(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateAvatarDto,
  ) {
    return this.usersService.updateAvatar(user.id, dto.avatar_key);
  }

  @ApiTags('Onboarding & Profile')
  @ApiOperation({ summary: 'Complete onboarding', description: 'Marks onboarding finished (is_onboarded = true). Call after name is set and first invite accepted.' })
  @Post('onboarding/complete')
  @HttpCode(HttpStatus.OK)
  async completeOnboarding(
    @CurrentUser() user: RequestUser,
  ): Promise<{ message: string }> {
    await this.usersService.completeOnboarding(user.id);
    return { message: 'Onboarding complete. Welcome to Saanjh.' };
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  @ApiTags('Settings')
  @ApiOperation({ summary: 'Get settings', description: 'Returns language, timezone, and all notification preferences.' })
  @Get('settings')
  getSettings(@CurrentUser() user: RequestUser) {
    return this.usersService.getSettings(user.id);
  }

  @ApiTags('Settings')
  @ApiOperation({ summary: 'Update settings', description: 'Partially updates user settings. Only provided fields are changed.' })
  @Patch('settings')
  updateSettings(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateSettingsDto,
  ) {
    return this.usersService.updateSettings(user.id, dto);
  }

  @ApiTags('Settings')
  @ApiOperation({ summary: 'Get feature flags', description: 'Returns which features are enabled for this user based on rollout_percentage. Flutter uses this to show/hide video recording, Memory Book, etc.' })
  @Get('settings/feature-flags')
  getFeatureFlags(@CurrentUser() user: RequestUser) {
    return this.usersService.getFeatureFlags(user.id);
  }

  @ApiTags('Settings')
  @ApiOperation({ summary: 'Request data export', description: 'Queues a GDPR/DPDP data export. User receives a notification with download link when ready (~10 min).' })
  @Get('settings/data-export')
  @HttpCode(HttpStatus.OK)
  async requestDataExport(
    @CurrentUser() user: RequestUser,
  ): Promise<{ message: string }> {
    await this.usersService.requestDataExport(user.id);
    return {
      message:
        'Your data export has been queued. You will receive a notification when it is ready.',
    };
  }
}
