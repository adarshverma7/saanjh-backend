import { Module } from '@nestjs/common';
import { FlickerController } from './flicker.controller';
import { FlickerService } from './flicker.service';
import { EventsService } from './events.service';

@Module({
  controllers: [FlickerController],
  providers: [
    FlickerService,
    // EventsService is shared: FlickerService pushes to it, EntriesService
    // will also push 'new_entry' events. Exported so other modules can push events.
    EventsService,
  ],
  exports: [FlickerService, EventsService],
})
export class FlickerModule {}
