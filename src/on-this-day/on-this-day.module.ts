import { Module } from '@nestjs/common';
import { OnThisDayController } from './on-this-day.controller';
import { OnThisDayService } from './on-this-day.service';

@Module({
  controllers: [OnThisDayController],
  providers: [OnThisDayService],
  exports: [OnThisDayService],
})
export class OnThisDayModule {}
