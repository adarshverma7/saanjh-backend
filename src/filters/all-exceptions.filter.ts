import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import * as Sentry from '@sentry/node';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json({
        error: {
          code: 'HTTP_ERROR',
          message: exception.message,
          statusCode: exception.getStatus(),
        },
      });
      return;
    }

    // Unexpected 500 — log and report to Sentry
    this.logger.error(
      'Unhandled exception',
      exception instanceof Error ? exception.stack : String(exception),
    );

    if (process.env.SENTRY_DSN) {
      Sentry.captureException(exception);
    }

    response.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong',
        statusCode: 500,
      },
    });
  }
}
