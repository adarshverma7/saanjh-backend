import { Module } from '@nestjs/common';
import { StoriesController } from './stories.controller';
import { StoriesService } from './stories.service';
import { StorageModule } from '../shared/storage/storage.module';
import { FlickerModule } from '../flicker/flicker.module';

@Module({
  imports: [
    StorageModule,
    // EventsService (from FlickerModule) pushes story_added over existing
    // per-connection SSE streams when a partner publishes a story.
    FlickerModule,
  ],
  controllers: [StoriesController],
  providers: [StoriesService],
  exports: [StoriesService],
})
export class StoriesModule {}
