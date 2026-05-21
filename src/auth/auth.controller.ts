import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, SessionInfo } from './auth.service';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ConfirmDeleteDto } from './dto/confirm-delete.dto';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

class VerifyFirebaseDto {
  @IsString() @IsNotEmpty() id_token: string;
  @IsString() @IsNotEmpty() device_id: string;
  @IsOptional() @IsString() device_type?: string;
  @IsOptional() @IsString() app_version?: string;
  @IsOptional() @IsString() fcm_token?: string;
}
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RateLimitGuard, RateLimit } from '../guards/rate-limit.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import type { RequestUser } from './strategies/jwt.strategy';

interface AuthenticatedRequest extends Request {
  user: RequestUser;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ── OTP ────────────────────────────────────────────────────────────────────

  /**
   * POST /v1/auth/otp/send
   * Sends a 6-digit OTP to the phone number via SMS.
   * Rate limited: 3 per phone per 10 min, 15 per IP per hour.
   */
  @Post('otp/send')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(3, 600, 'otp:send')
  async sendOtp(
    @Body() dto: SendOtpDto,
    @Req() req: Request,
  ): Promise<{ message: string; expires_in: number }> {
    const ip = req.ip ?? req.socket.remoteAddress;
    await this.authService.sendOtp(dto.phone, ip);
    return { message: 'OTP sent successfully', expires_in: 600 };
  }

  /**
   * POST /v1/auth/otp/verify
   * Verifies OTP and issues access + refresh tokens.
   * Creates a new user account if the phone is not registered.
   */
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto.phone, dto.otp, {
      device_id: dto.device_id,
      device_type: dto.device_type,
      app_version: dto.app_version,
      fcm_token: dto.fcm_token,
    });
  }

  /**
   * POST /v1/auth/firebase/verify
   * Accepts a Firebase ID token (issued after phone OTP verified by Firebase in Flutter).
   * Creates user if new, returns our own JWT pair.
   */
  @Post('firebase/verify')
  @HttpCode(HttpStatus.OK)
  async verifyFirebase(@Body() dto: VerifyFirebaseDto) {
    return this.authService.verifyFirebaseToken(dto.id_token, {
      device_id:   dto.device_id,
      device_type: dto.device_type,
      app_version: dto.app_version,
      fcm_token:   dto.fcm_token,
    });
  }

  // ── Token ──────────────────────────────────────────────────────────────────

  /**
   * POST /v1/auth/token/refresh
   * Rotates the refresh token and issues a new access token.
   * The old refresh token is immediately invalidated.
   */
  @Post('token/refresh')
  @HttpCode(HttpStatus.OK)
  async refreshToken(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto.refresh_token, dto.device_id);
  }

  // ── Session management ─────────────────────────────────────────────────────

  /**
   * POST /v1/auth/logout
   * Deactivates the current device session and clears the refresh token.
   */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async logout(@CurrentUser() user: RequestUser): Promise<{ message: string }> {
    await this.authService.logout(user.id, user.device_id);
    return { message: 'Logged out successfully' };
  }

  /**
   * GET /v1/auth/sessions
   * Returns all active device sessions for the current user.
   * Used for "Manage devices" screen.
   */
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async getSessions(@CurrentUser() user: RequestUser): Promise<SessionInfo[]> {
    return this.authService.getSessions(user.id);
  }

  /**
   * DELETE /v1/auth/sessions/:id
   * Remotely revokes a specific device session (force logout that device).
   */
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async revokeSession(
    @CurrentUser() user: RequestUser,
    @Param('id') sessionId: string,
  ): Promise<{ message: string }> {
    await this.authService.revokeSession(user.id, sessionId);
    return { message: 'Session revoked' };
  }

  // ── Account deletion ───────────────────────────────────────────────────────

  /**
   * POST /v1/auth/account/delete/request
   * Sends a deletion-confirmation OTP. Starts the deletion flow.
   * 30-day grace period before data is permanently removed.
   */
  @Post('account/delete/request')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async requestAccountDeletion(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ message: string }> {
    // We need the phone to send OTP — fetch it from DB (user object only has masked phone)
    const rows = await this.getPhoneForUser(user.id, req);
    await this.authService.requestAccountDeletion(user.id, rows);
    return { message: 'Deletion OTP sent. You have 30 days to cancel after confirming.' };
  }

  /**
   * POST /v1/auth/account/delete/confirm
   * Verifies OTP and soft-deletes the account.
   * User is logged out from all devices immediately.
   */
  @Post('account/delete/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async confirmAccountDeletion(
    @CurrentUser() user: RequestUser,
    @Body() dto: ConfirmDeleteDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ message: string }> {
    const phone = await this.getPhoneForUser(user.id, req);
    await this.authService.confirmAccountDeletion(user.id, phone, dto.otp);
    return {
      message:
        'Account deletion confirmed. All data will be permanently removed in 30 days.',
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  // Fetches the raw (unmasked) phone from the service layer.
  // We avoid exposing raw phone in the user JWT payload / RequestUser object.
  private async getPhoneForUser(
    userId: string,
    _req: AuthenticatedRequest,
  ): Promise<string> {
    // The authService exposes this via a small helper query
    return this.authService.getRawPhone(userId);
  }
}
