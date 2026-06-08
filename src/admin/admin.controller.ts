import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiSecurity } from '@nestjs/swagger';
import { AdminGuard } from '../guards/admin.guard';
import { AdminService } from './admin.service';

class SuspendUserDto {
  reason: string;
}

class UpdateFlagDto {
  is_enabled: boolean;
  rollout_percentage: number;
}

class UpdateOrderDto {
  print_status: string;
  tracking_number?: string;
}

@ApiTags('Admin')
@ApiSecurity('JWT')
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ── Users ──────────────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'List users', description: 'Admin: paginated user list with optional search.' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  @Get('users')
  async getUserList(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('search') @Optional() search?: string,
  ) {
    return this.adminService.getUserList(page, limit, search);
  }

  @ApiOperation({ summary: 'Get user detail' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @Get('users/:id')
  async getUserDetail(@Param('id') userId: string) {
    return this.adminService.getUserDetail(userId);
  }

  @ApiOperation({ summary: 'Suspend user' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @Patch('users/:id/suspend')
  @HttpCode(HttpStatus.NO_CONTENT)
  async suspendUser(
    @Param('id') userId: string,
    @Body() dto: SuspendUserDto,
    // Admin identity from token — in a real system you'd decode the token here.
    // For now we use a placeholder; full admin identity tracking is a future enhancement.
  ) {
    await this.adminService.suspendUser('admin', userId, dto.reason ?? 'No reason given');
  }

  // ── Analytics ──────────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'Analytics overview', description: 'Total users, connections, entries, and active-today counts.' })
  @Get('analytics/overview')
  async getAnalyticsOverview() {
    return this.adminService.getAnalyticsOverview();
  }

  @ApiOperation({ summary: 'Daily entry counts', description: 'Last 30 days of per-type entry counts.' })
  @Get('analytics/entries')
  async getDailyEntryCounts() {
    return this.adminService.getDailyEntryCounts();
  }

  @ApiOperation({ summary: 'Daily flicker counts', description: 'Last 30 days of flicker and mutual-reveal counts.' })
  @Get('analytics/flickers')
  async getDailyFlickerCounts() {
    return this.adminService.getDailyFlickerCounts();
  }

  // ── Feature Flags ──────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'List feature flags' })
  @Get('feature-flags')
  async getFeatureFlags() {
    return this.adminService.getFeatureFlags();
  }

  @ApiOperation({ summary: 'Update feature flag', description: 'Toggle a feature flag on/off and set rollout percentage.' })
  @ApiParam({ name: 'key', description: 'Feature flag key' })
  @Patch('feature-flags/:key')
  async updateFeatureFlag(
    @Param('key') key: string,
    @Body() dto: UpdateFlagDto,
  ) {
    return this.adminService.updateFeatureFlag(key, dto.is_enabled, dto.rollout_percentage);
  }

  // ── Orders ─────────────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'List all orders (admin)' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'status', required: false })
  @Get('orders')
  async getOrders(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') @Optional() status?: string,
  ) {
    return this.adminService.getOrders(page, limit, status);
  }

  @ApiOperation({ summary: 'Update order status', description: 'Update print_status and optionally set a tracking number.' })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @Patch('orders/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateOrderStatus(
    @Param('id') orderId: string,
    @Body() dto: UpdateOrderDto,
  ) {
    await this.adminService.updateOrderStatus(orderId, dto.print_status, dto.tracking_number);
  }
}
