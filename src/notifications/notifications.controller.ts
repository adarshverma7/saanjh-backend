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
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { ReadNotificationsDto } from './dto/read-notifications.dto';
import { UpdateNotificationPreferencesDto } from './dto/notification-preferences.dto';
import { DeviceTokenDto } from './dto/device-token.dto';

@ApiTags('Notifications')
@ApiBearerAuth('JWT')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @ApiOperation({ summary: 'List notifications', description: 'Paginated in-app notification feed.' })
  @ApiQuery({ name: 'filter', required: false, enum: ['all', 'unread'] })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
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

  @ApiOperation({ summary: 'Mark notifications as read', description: 'Marks an array of notification IDs as read.' })
  @Post('read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAsRead(
    @CurrentUser('sub') userId: string,
    @Body() dto: ReadNotificationsDto,
  ): Promise<void> {
    await this.notificationsService.markAsRead(userId, dto.ids);
  }

  @ApiOperation({ summary: 'Get notification preferences' })
  @Get('preferences')
  async getPreferences(@CurrentUser('sub') userId: string) {
    return this.notificationsService.getPreferences(userId);
  }

  @ApiOperation({ summary: 'Update notification preferences' })
  @Put('preferences')
  async updatePreferences(
    @CurrentUser('sub') userId: string,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.notificationsService.updatePreferences(userId, dto);
  }

  @ApiOperation({ summary: 'Register FCM device token', description: 'Registers or updates the Firebase Cloud Messaging token for push notifications.' })
  @Post('device-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  async registerDeviceToken(
    @CurrentUser('sub') userId: string,
    @Body() dto: DeviceTokenDto,
  ): Promise<void> {
    await this.notificationsService.registerDeviceToken(userId, dto);
  }
}
