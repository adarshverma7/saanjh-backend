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
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
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

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ── OTP ────────────────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'Send OTP', description: 'Sends a 6-digit OTP via SMS. Rate limited: 3/phone/10 min.' })
  @ApiResponse({ status: 200, description: 'OTP sent' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
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

  @ApiOperation({ summary: 'Verify OTP', description: 'Verifies OTP and issues access + refresh tokens. Creates account if new.' })
  @ApiResponse({ status: 200, description: 'JWT pair returned' })
  @ApiResponse({ status: 401, description: 'Invalid or expired OTP' })
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

  @ApiOperation({ summary: 'Verify Firebase token', description: 'Exchange a Firebase phone-OTP ID token for a Saanjh JWT pair. Creates account if new.' })
  @ApiBody({ schema: { example: { id_token: 'firebase-id-token', device_id: 'uuid', device_type: 'android', app_version: '1.0.0', fcm_token: 'fcm-token' } } })
  @ApiResponse({ status: 200, description: 'JWT pair returned' })
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

  @ApiOperation({ summary: 'Refresh access token', description: 'Rotates the refresh token and issues a new access token. Old token is invalidated immediately.' })
  @ApiResponse({ status: 200, description: 'New JWT pair' })
  @Post('token/refresh')
  @HttpCode(HttpStatus.OK)
  async refreshToken(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto.refresh_token, dto.device_id);
  }

  // ── Session management ─────────────────────────────────────────────────────

  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Logout', description: 'Deactivates the current device session and clears the refresh token.' })
  @ApiResponse({ status: 200, description: 'Logged out' })
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async logout(@CurrentUser() user: RequestUser): Promise<{ message: string }> {
    await this.authService.logout(user.id, user.device_id);
    return { message: 'Logged out successfully' };
  }

  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'List active sessions', description: 'Returns all active device sessions. Used for "Manage devices" screen.' })
  @ApiResponse({ status: 200, description: 'Array of sessions' })
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async getSessions(@CurrentUser() user: RequestUser): Promise<SessionInfo[]> {
    return this.authService.getSessions(user.id);
  }

  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Revoke a session', description: 'Remotely revokes a specific device session (force logout that device).' })
  @ApiResponse({ status: 200, description: 'Session revoked' })
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

  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Request account deletion', description: 'Sends OTP for deletion confirmation. 30-day grace period before permanent removal.' })
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

  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Confirm account deletion', description: 'Verifies OTP and soft-deletes the account. Logs out all devices immediately.' })
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
