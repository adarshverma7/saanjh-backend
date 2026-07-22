import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { DataExportService } from './data-export.service';
import { StorageModule } from '../shared/storage/storage.module';

@Module({
  imports: [
    // StorageService — for avatar pre-signed URLs and R2 object management
    StorageModule,
  ],
  controllers: [UsersController],
  providers: [UsersService, DataExportService],
  exports: [UsersService],
})
export class UsersModule {}
