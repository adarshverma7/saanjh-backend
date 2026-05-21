import { Module } from '@nestjs/common';
import { MemoryJarController } from './memory-jar.controller';
import { MemoryJarService } from './memory-jar.service';

@Module({
  controllers: [MemoryJarController],
  providers: [MemoryJarService],
  exports: [MemoryJarService],
})
export class MemoryJarModule {}
