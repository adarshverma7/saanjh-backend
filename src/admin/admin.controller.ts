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

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ── Users ──────────────────────────────────────────────────────────────────

  @Get('users')
  async getUserList(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('search') @Optional() search?: string,
  ) {
    return this.adminService.getUserList(page, limit, search);
  }

  @Get('users/:id')
  async getUserDetail(@Param('id') userId: string) {
    return this.adminService.getUserDetail(userId);
  }

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

  @Get('analytics/overview')
  async getAnalyticsOverview() {
    return this.adminService.getAnalyticsOverview();
  }

  @Get('analytics/entries')
  async getDailyEntryCounts() {
    return this.adminService.getDailyEntryCounts();
  }

  @Get('analytics/flickers')
  async getDailyFlickerCounts() {
    return this.adminService.getDailyFlickerCounts();
  }

  // ── Feature Flags ──────────────────────────────────────────────────────────

  @Get('feature-flags')
  async getFeatureFlags() {
    return this.adminService.getFeatureFlags();
  }

  @Patch('feature-flags/:key')
  async updateFeatureFlag(
    @Param('key') key: string,
    @Body() dto: UpdateFlagDto,
  ) {
    return this.adminService.updateFeatureFlag(key, dto.is_enabled, dto.rollout_percentage);
  }

  // ── Orders ─────────────────────────────────────────────────────────────────

  @Get('orders')
  async getOrders(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') @Optional() status?: string,
  ) {
    return this.adminService.getOrders(page, limit, status);
  }

  @Patch('orders/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateOrderStatus(
    @Param('id') orderId: string,
    @Body() dto: UpdateOrderDto,
  ) {
    await this.adminService.updateOrderStatus(orderId, dto.print_status, dto.tracking_number);
  }
}
