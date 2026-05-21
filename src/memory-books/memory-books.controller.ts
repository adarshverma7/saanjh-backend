import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { MemoryBooksService } from './memory-books.service';
import { PreviewBookDto } from './dto/preview-book.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';

@Controller('memory-books')
@UseGuards(JwtAuthGuard)
export class MemoryBooksController {
  constructor(private readonly memoryBooksService: MemoryBooksService) {}

  @Post('preview')
  async previewBook(
    @CurrentUser('sub') userId: string,
    @Body() dto: PreviewBookDto,
  ) {
    return this.memoryBooksService.previewBook(userId, dto);
  }

  @Post('orders')
  async createOrder(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateOrderDto,
  ) {
    return this.memoryBooksService.createOrder(userId, dto);
  }

  @Post('orders/:id/payment/verify')
  async verifyPayment(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() dto: VerifyPaymentDto,
  ) {
    return this.memoryBooksService.verifyPayment(userId, orderId, dto);
  }

  @Get('orders')
  async getOrders(@CurrentUser('sub') userId: string) {
    return this.memoryBooksService.getOrders(userId);
  }

  @Get('orders/:id')
  async getOrder(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) orderId: string,
  ) {
    return this.memoryBooksService.getOrder(userId, orderId);
  }
}
