import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { MemoryBooksService } from './memory-books.service';
import { PreviewBookDto } from './dto/preview-book.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';

@ApiTags('Memory Books')
@ApiBearerAuth('JWT')
@Controller('memory-books')
@UseGuards(JwtAuthGuard)
export class MemoryBooksController {
  constructor(private readonly memoryBooksService: MemoryBooksService) {}

  @ApiOperation({ summary: 'Preview memory book', description: 'Generates a preview of a photo-book from selected diary entries.' })
  @Post('preview')
  async previewBook(
    @CurrentUser('sub') userId: string,
    @Body() dto: PreviewBookDto,
  ) {
    return this.memoryBooksService.previewBook(userId, dto);
  }

  @ApiOperation({ summary: 'Create order', description: 'Creates a Razorpay order for a memory book print.' })
  @Post('orders')
  async createOrder(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateOrderDto,
  ) {
    return this.memoryBooksService.createOrder(userId, dto);
  }

  @ApiOperation({ summary: 'Verify Razorpay payment', description: 'Verifies the payment signature from Razorpay and marks the order as paid.' })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @Post('orders/:id/payment/verify')
  async verifyPayment(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() dto: VerifyPaymentDto,
  ) {
    return this.memoryBooksService.verifyPayment(userId, orderId, dto);
  }

  @ApiOperation({ summary: 'List orders', description: 'Returns all memory book orders for the current user.' })
  @Get('orders')
  async getOrders(@CurrentUser('sub') userId: string) {
    return this.memoryBooksService.getOrders(userId);
  }

  @ApiOperation({ summary: 'Get order', description: 'Returns a single order with current print status and tracking info.' })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @Get('orders/:id')
  async getOrder(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) orderId: string,
  ) {
    return this.memoryBooksService.getOrder(userId, orderId);
  }
}
