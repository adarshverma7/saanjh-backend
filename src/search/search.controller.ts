import { Controller, Get, Query, UseGuards, ParseIntPipe, DefaultValuePipe, Optional } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { SearchService } from './search.service';

@ApiTags('Search')
@ApiBearerAuth('JWT')
@Controller('search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @ApiOperation({ summary: 'Search diary entries', description: 'Full-text search across all diary entries. Optionally scoped to a single connection.' })
  @ApiQuery({ name: 'q', description: 'Search query string' })
  @ApiQuery({ name: 'connection_id', required: false, description: 'Scope search to one connection' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max results (default 20)' })
  @Get('entries')
  async searchEntries(
    @CurrentUser('sub') userId: string,
    @Query('q') query: string,
    @Query('connection_id') @Optional() connectionId?: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    return this.searchService.searchEntries(userId, query ?? '', connectionId, limit);
  }
}
