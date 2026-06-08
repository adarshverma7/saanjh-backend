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
import { ApiTags, ApiOperation, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { ConnectionMemberGuard } from '../guards/connection-member.guard';
import { RateLimitGuard, RateLimit } from '../guards/rate-limit.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { OccasionsService } from './occasions.service';
import { CreateOccasionDto } from './dto/create-occasion.dto';
import { GenerateMessageDto } from './dto/generate-message.dto';

@ApiTags('Occasions')
@ApiBearerAuth('JWT')
@ApiParam({ name: 'id', description: 'Connection UUID' })
@Controller('connections/:id/occasions')
@UseGuards(JwtAuthGuard, ConnectionMemberGuard)
export class OccasionsController {
  constructor(private readonly occasionsService: OccasionsService) {}

  @ApiOperation({ summary: 'List occasions', description: 'Returns all upcoming special dates for this connection.' })
  @Get()
  async getOccasions(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) connectionId: string,
  ) {
    return this.occasionsService.getOccasions(userId, connectionId);
  }

  @ApiOperation({ summary: 'Create occasion', description: 'Adds a new special date (birthday, anniversary, etc.).' })
  @Post()
  async createOccasion(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) connectionId: string,
    @Body() dto: CreateOccasionDto,
  ) {
    return this.occasionsService.createOccasion(userId, connectionId, dto);
  }

  @ApiOperation({ summary: 'Delete occasion' })
  @ApiParam({ name: 'occasionId', description: 'Occasion UUID' })
  @Delete(':occasionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteOccasion(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) connectionId: string,
    @Param('occasionId', ParseUUIDPipe) occasionId: string,
  ): Promise<void> {
    await this.occasionsService.deleteOccasion(userId, connectionId, occasionId);
  }

  @ApiOperation({ summary: 'Generate AI message', description: 'Generates an AI-written message for the occasion. Rate limited: 5/day.' })
  @ApiParam({ name: 'occasionId', description: 'Occasion UUID' })
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
