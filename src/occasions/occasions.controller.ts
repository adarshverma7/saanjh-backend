import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { ConnectionMemberGuard } from '../guards/connection-member.guard';
import { RateLimitGuard, RateLimit } from '../guards/rate-limit.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { OccasionsService } from './occasions.service';
import { CreateOccasionDto } from './dto/create-occasion.dto';
import { GenerateMessageDto } from './dto/generate-message.dto';

@Controller('connections/:id/occasions')
@UseGuards(JwtAuthGuard, ConnectionMemberGuard)
export class OccasionsController {
  constructor(private readonly occasionsService: OccasionsService) {}

  @Get()
  async getOccasions(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) connectionId: string,
  ) {
    return this.occasionsService.getOccasions(userId, connectionId);
  }

  @Post()
  async createOccasion(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) connectionId: string,
    @Body() dto: CreateOccasionDto,
  ) {
    return this.occasionsService.createOccasion(userId, connectionId, dto);
  }

  @Delete(':occasionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteOccasion(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) connectionId: string,
    @Param('occasionId', ParseUUIDPipe) occasionId: string,
  ): Promise<void> {
    await this.occasionsService.deleteOccasion(userId, connectionId, occasionId);
  }

  @Post(':occasionId/generate')
  @UseGuards(RateLimitGuard)
  @RateLimit(5, 86400, 'occasions:generate')
  async generateAiMessage(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) connectionId: string,
    @Param('occasionId', ParseUUIDPipe) occasionId: string,
    @Body() dto: GenerateMessageDto,
  ) {
    const message = await this.occasionsService.generateAiMessage(
      userId,
      connectionId,
      occasionId,
      dto,
    );
    return { message };
  }
}
