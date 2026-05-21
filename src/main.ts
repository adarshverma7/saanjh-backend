import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import * as Sentry from '@sentry/node';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { LoggingInterceptor } from './interceptors/logging.interceptor';

async function bootstrap(): Promise<void> {
  // Sentry must be initialised before the app to capture bootstrap errors
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV ?? 'development',
      tracesSampleRate: 0.1,
    });
  }

  const app = await NestFactory.create(AppModule);

  // Security headers
  app.use(helmet());

  // CORS
  const rawOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()) ?? ['*'];
  app.enableCors({
    origin: rawOrigins.includes('*') ? '*' : rawOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  // All routes are /v1/...
  app.setGlobalPrefix('v1');

  // Validation — strips unknown fields, auto-transforms primitives
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Filters — AllExceptions first (outer), HttpException inner
  app.useGlobalFilters(new AllExceptionsFilter(), new HttpExceptionFilter());

  // Logging interceptor
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Graceful shutdown (SIGTERM closes DB pool, drains Bull queue)
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Saanjh API running on :${port} [${process.env.NODE_ENV ?? 'development'}]`);
}

bootstrap();
