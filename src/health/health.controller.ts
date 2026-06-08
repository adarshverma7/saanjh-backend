import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StorageService } from '../shared/storage/storage.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: StorageService,
  ) {}

  @ApiOperation({ summary: 'Health check', description: 'Returns DB and B2 connectivity status, uptime, and version. No auth required.' })
  @ApiResponse({ status: 200, schema: { example: { status: 'ok', db: 'ok', storage: 'b2_connected', uptime: 1234, version: '1.0.0' } } })
  @Get()
  async check() {
    let dbStatus = 'ok';
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      dbStatus = 'error';
    }

    const storageOk = await this.storage.checkConnectivity().catch(() => false);

    return {
      status: 'ok',
      db: dbStatus,
      storage: storageOk ? 'b2_connected' : 'b2_error',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      version: process.env.npm_package_version ?? '0.0.1',
    };
  }
}
