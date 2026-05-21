import { Module } from '@nestjs/common';
import { MemoryTreeController } from './memory-tree.controller';
import { MemoryTreeService } from './memory-tree.service';

@Module({
  controllers: [MemoryTreeController],
  providers: [MemoryTreeService],
  // Export so EntriesService can call invalidateCache() when entries are created/deleted
  exports: [MemoryTreeService],
})
export class MemoryTreeModule {}
