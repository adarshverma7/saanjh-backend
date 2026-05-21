import { Controller, Get, Query, UseGuards, ParseIntPipe, DefaultValuePipe, Optional } from '@nestjs/common';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { SearchService } from './search.service';

@Controller('search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

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
