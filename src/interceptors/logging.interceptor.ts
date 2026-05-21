import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request } from 'express';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const { method, url } = req;
    const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'anon';
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.log(`${method} ${url} [${userId}] — ${Date.now() - start}ms`);
        },
        error: (err: Error) => {
          this.logger.error(`${method} ${url} [${userId}] — ${Date.now() - start}ms — ${err.message}`);
        },
      }),
    );
  }
}
