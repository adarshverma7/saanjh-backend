import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationCronService } from './notification-cron.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationCronService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
