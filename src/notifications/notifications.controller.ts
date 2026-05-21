import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { ReadNotificationsDto } from './dto/read-notifications.dto';
import { UpdateNotificationPreferencesDto } from './dto/notification-preferences.dto';
import { DeviceTokenDto } from './dto/device-token.dto';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  async listNotifications(
    @CurrentUser('sub') userId: string,
    @Query() dto: ListNotificationsDto,
  ) {
    return this.notificationsService.getNotifications(
      userId,
      dto.filter ?? 'all',
      dto.limit ?? 20,
      dto.cursor,
    );
  }

  @Post('read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAsRead(
    @CurrentUser('sub') userId: string,
    @Body() dto: ReadNotificationsDto,
  ): Promise<void> {
    await this.notificationsService.markAsRead(userId, dto.ids);
  }

  @Get('preferences')
  async getPreferences(@CurrentUser('sub') userId: string) {
    return this.notificationsService.getPreferences(userId);
  }

  @Put('preferences')
  async updatePreferences(
    @CurrentUser('sub') userId: string,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.notificationsService.updatePreferences(userId, dto);
  }

  @Post('device-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  async registerDeviceToken(
    @CurrentUser('sub') userId: string,
    @Body() dto: DeviceTokenDto,
  ): Promise<void> {
    await this.notificationsService.registerDeviceToken(userId, dto);
  }
}
