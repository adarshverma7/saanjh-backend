import { Module } from '@nestjs/common';
import { EntriesController } from './entries.controller';
import { EntriesService } from './entries.service';
import { StorageModule } from '../shared/storage/storage.module';
import { StreaksModule } from '../streaks/streaks.module';

@Module({
  imports: [
    StorageModule,
    // StreaksService is injected into EntriesService.
    // Each new diary entry calls streaksService.onNewEntry() to update the streak.
    StreaksModule,
  ],
  controllers: [EntriesController],
  providers: [EntriesService],
  exports: [EntriesService],
})
export class EntriesModule {}
