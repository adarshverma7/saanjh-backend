import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import * as Sentry from '@sentry/node';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
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

  // ── Swagger ────────────────────────────────────────────────────────────────
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Saanjh API')
    .setDescription(
      'REST API for the Saanjh couples-diary app.\n\n' +
      '**Auth:** All protected routes require `Authorization: Bearer <access_token>`.\n' +
      'Get a token from `POST /v1/auth/firebase/verify` (Firebase phone OTP flow).',
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', in: 'header' },
      'JWT',
    )
    // One tag per logical feature group — same order as the UI sidebar
    .addTag('Health', 'Liveness / readiness probe')
    .addTag('Auth', 'OTP, Firebase verify, token refresh, sessions, account deletion')
    .addTag('Onboarding & Profile', 'Profile setup, avatar upload, onboarding complete')
    .addTag('Settings', 'User preferences, feature flags, data export')
    .addTag('Connections', 'Invite flow, active connections, direct connect, contact discovery')
    .addTag('Diary Entries', 'Voice / video / text diary entries per connection (Telegram-style upload)')
    .addTag('Flicker & Events', 'Presence signals (Flicker), SSE real-time stream')
    .addTag('Streaks', 'Streak data and milestone celebrations')
    .addTag('Memory Tree', 'Full memory tree and per-month detail')
    .addTag('Memory Jar', 'Starred memories — surface random + list all')
    .addTag('On This Day', 'Entries from the same date in past years')
    .addTag('Search', 'Full-text search across diary entries')
    .addTag('Journal', 'Private personal journal (not shared with partner)')
    .addTag('Notifications', 'In-app notification feed, preferences, device token')
    .addTag('Occasions', 'Special dates & AI message generation')
    .addTag('Memory Books', 'Printed photo-book orders via Razorpay')
    .addTag('Admin', 'Internal admin panel — requires admin token')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      filter: true,
      displayRequestDuration: true,
    },
    customSiteTitle: 'Saanjh API Docs',
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Saanjh API running on :${port} [${process.env.NODE_ENV ?? 'development'}]`);
  console.log(`Swagger docs: http://localhost:${port}/docs`);
}

bootstrap();
