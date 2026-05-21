import { Module } from '@nestjs/common';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { StorageModule } from '../shared/storage/storage.module';

@Module({
  imports: [
    // StorageService — for partner avatar signed URLs
    StorageModule,
  ],
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
