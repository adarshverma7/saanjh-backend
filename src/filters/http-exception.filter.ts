import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status = exception.getStatus();
    const body = exception.getResponse();

    const errorCode =
      typeof body === 'object' && body !== null && 'error' in body
        ? (body as Record<string, unknown>).error
        : exception.name;

    const errorMessage =
      typeof body === 'object' && body !== null && 'message' in body
        ? (body as Record<string, unknown>).message
        : exception.message;

    response.status(status).json({
      error: {
        code: errorCode,
        message: errorMessage,
        statusCode: status,
      },
    });
  }
}
