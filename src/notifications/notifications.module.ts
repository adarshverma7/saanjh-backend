import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationCronService } from './notification-cron.service';
import { NotificationWorkerService } from './notification-worker.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationCronService, NotificationWorkerService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
