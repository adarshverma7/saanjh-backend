import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { MemoryBooksController } from './memory-books.controller';
import { MemoryBooksService } from './memory-books.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'pdf' })],
  controllers: [MemoryBooksController],
  providers: [MemoryBooksService],
  exports: [MemoryBooksService],
})
export class MemoryBooksModule {}
