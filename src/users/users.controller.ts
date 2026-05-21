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
@Controller()
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ── Onboarding ─────────────────────────────────────────────────────────────

  /**
   * GET /v1/onboarding/status
   * Returns which onboarding step the user is on.
   * Flutter checks this on app start to decide which screen to show.
   */
  @Get('onboarding/status')
  getOnboardingStatus(@CurrentUser() user: RequestUser) {
    return this.usersService.getOnboardingStatus(user.id);
  }

  /**
   * PUT /v1/onboarding/profile
   * Sets up the user's display name, language, date of birth, timezone.
   * Replaces whatever was set before (idempotent — safe to call multiple times).
   */
  @Put('onboarding/profile')
  updateProfile(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(user.id, dto);
  }

  /**
   * POST /v1/onboarding/avatar/upload-url
   * Returns a pre-signed R2 URL for direct avatar upload from Flutter.
   * Upload the image to upload_url, then call PATCH /onboarding/avatar.
   */
  @Post('onboarding/avatar/upload-url')
  @HttpCode(HttpStatus.OK)
  getAvatarUploadUrl(@CurrentUser() user: RequestUser) {
    return this.usersService.getAvatarUploadUrl(user.id);
  }

  /**
   * PATCH /v1/onboarding/avatar
   * Confirms the avatar upload completed and updates users.avatar_key.
   * Deletes the previous avatar from R2.
   */
  @Patch('onboarding/avatar')
  updateAvatar(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateAvatarDto,
  ) {
    return this.usersService.updateAvatar(user.id, dto.avatar_key);
  }

  /**
   * POST /v1/onboarding/complete
   * Marks onboarding as finished — sets is_onboarded = true.
   * Flutter calls this after the user has set name and accepted the first invite.
   */
  @Post('onboarding/complete')
  @HttpCode(HttpStatus.OK)
  async completeOnboarding(
    @CurrentUser() user: RequestUser,
  ): Promise<{ message: string }> {
    await this.usersService.completeOnboarding(user.id);
    return { message: 'Onboarding complete. Welcome to Saanjh.' };
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  /**
   * GET /v1/settings
   * Returns the user's language, timezone, and all notification preferences.
   */
  @Get('settings')
  getSettings(@CurrentUser() user: RequestUser) {
    return this.usersService.getSettings(user.id);
  }

  /**
   * PATCH /v1/settings
   * Partially updates settings. Only provided fields are changed.
   */
  @Patch('settings')
  updateSettings(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateSettingsDto,
  ) {
    return this.usersService.updateSettings(user.id, dto);
  }

  /**
   * GET /v1/settings/feature-flags
   * Returns which features are enabled for this specific user.
   * Based on feature_flags.is_enabled + deterministic rollout_percentage.
   * Flutter uses this to show/hide video recording, Memory Book, etc.
   */
  @Get('settings/feature-flags')
  getFeatureFlags(@CurrentUser() user: RequestUser) {
    return this.usersService.getFeatureFlags(user.id);
  }

  /**
   * GET /v1/settings/data-export
   * Queues a GDPR/DPDP data export job for this user.
   * User receives a notification with a download link when ready (~10 min).
   */
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
