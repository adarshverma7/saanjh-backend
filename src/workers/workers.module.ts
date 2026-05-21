import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { StorageModule } from '../shared/storage/storage.module';
import { FlickerModule } from '../flicker/flicker.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TranscriptionWorker } from './transcription.worker';
import { CleanupWorker } from './cleanup.worker';
import { NotificationWorker } from './notification.worker';
import { PdfWorker } from './pdf.worker';
import { ScheduledTasksService } from './scheduled-tasks.service';

/**
 * Groups all background workers and scheduled tasks.
 * Imported by AppModule — registered at the application level.
 *
 * Workers declared here process jobs from the Bull queues registered in AppModule.
 * Each worker also has @OnEvent fallback handlers for operation without Redis.
 */
@Module({
  imports: [
    // Queue registrations — workers reference queues by name
    BullModule.registerQueue(
      { name: 'transcription' },
      { name: 'notification' },
      { name: 'pdf' },
      { name: 'cleanup' },
    ),
    // StorageService — used by TranscriptionWorker (R2 download) and CleanupWorker (R2 delete)
    StorageModule,
    // EventsService — used by TranscriptionWorker to broadcast SSE on transcription complete
    FlickerModule,
    // NotificationsService — used by NotificationWorker
    NotificationsModule,
  ],
  providers: [
    TranscriptionWorker,
    CleanupWorker,
    NotificationWorker,
    PdfWorker,
    ScheduledTasksService,
  ],
  exports: [
    // Export workers so other modules can inject queues if needed
    ScheduledTasksService,
  ],
})
export class WorkersModule {}
