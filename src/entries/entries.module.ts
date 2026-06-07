import { Module } from '@nestjs/common';
import { EntriesController } from './entries.controller';
import { EntriesService } from './entries.service';
import { StorageModule } from '../shared/storage/storage.module';
import { StreaksModule } from '../streaks/streaks.module';
import { FlickerModule } from '../flicker/flicker.module';

@Module({
  imports: [
    StorageModule,
    StreaksModule,
    // EventsService (from FlickerModule) is injected into EntriesService
    // to push SSE new_entry events to the partner when an upload is confirmed.
    FlickerModule,
  ],
  controllers: [EntriesController],
  providers: [EntriesService],
  exports: [EntriesService],
})
export class EntriesModule {}
