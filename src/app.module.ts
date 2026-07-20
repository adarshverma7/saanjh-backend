import { Module, MiddlewareConsumer, NestModule, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtModule } from '@nestjs/jwt';
import { BullModule } from '@nestjs/bull';

import configuration from './shared/config/configuration';
import { envValidationSchema } from './shared/config/env.validation';
import { DatabaseModule } from './shared/database/database.module';
import { StorageModule } from './shared/storage/storage.module';
import { ActivityMiddleware } from './middleware/activity.middleware';
import { ConnectionMemberGuard } from './guards/connection-member.guard';
import { AdminGuard } from './guards/admin.guard';
import { RateLimitGuard } from './guards/rate-limit.guard';

// Feature modules
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ConnectionsModule } from './connections/connections.module';
import { EntriesModule } from './entries/entries.module';
import { FlickerModule } from './flicker/flicker.module';
import { StoriesModule } from './stories/stories.module';
import { MemoryTreeModule } from './memory-tree/memory-tree.module';
import { OnThisDayModule } from './on-this-day/on-this-day.module';
import { MemoryJarModule } from './memory-jar/memory-jar.module';
import { StreaksModule } from './streaks/streaks.module';
import { JournalModule } from './journal/journal.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OccasionsModule } from './occasions/occasions.module';
import { MemoryBooksModule } from './memory-books/memory-books.module';
import { SearchModule } from './search/search.module';
import { AdminModule } from './admin/admin.module';

// Workers
import { WorkersModule } from './workers/workers.module';

// Health
import { HealthController } from './health/health.controller';

const bullLogger = new Logger('BullModule');

@Module({
  imports: [
    // ── Core infrastructure ────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),

    // JWT globally available (auth module overrides signing options per-call)
    JwtModule.register({ global: true }),

    // Cron scheduler
    ScheduleModule.forRoot(),

    // Event emitter (inter-module events — also used as Bull fallback without Redis)
    EventEmitterModule.forRoot(),

    // ── Bull queue infrastructure ──────────────────────────────────────────
    // MVP: REDIS_URL not required. Without Redis, Bull queues are registered
    // but jobs are delivered via EventEmitter (@OnEvent handlers in workers).
    // Production: set REDIS_URL on Railway → jobs get persistence + retry.
    // TODO: configure REDIS_URL on Railway when user base grows past 500 users.
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('redisUrl');
        if (redisUrl) {
          bullLogger.log('Bull connecting to Redis: ' + redisUrl.split('@').pop());
          return { redis: { url: redisUrl } };
        }
        bullLogger.warn(
          'REDIS_URL not set — Bull queues registered but inactive. ' +
          'Jobs run via EventEmitter. Add REDIS_URL for persistence + retry.',
        );
        // Use a non-existent local Redis — Bull will fail gracefully on queue.add()
        // All workers have @OnEvent fallbacks that handle the real processing.
        return {
          redis: { host: '127.0.0.1', port: 6379, lazyConnect: true },
          defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
        };
      },
    }),
    // Register all four queues — workers reference them by name
    BullModule.registerQueue(
      { name: 'transcription' },
      { name: 'notification' },
      { name: 'pdf' },
      { name: 'cleanup' },
    ),

    // ── Database & storage ────────────────────────────────────────────────
    DatabaseModule,
    StorageModule,

    // ── Feature modules ────────────────────────────────────────────────────
    AuthModule,
    UsersModule,
    ConnectionsModule,
    EntriesModule,
    FlickerModule,
    StoriesModule,
    MemoryTreeModule,
    OnThisDayModule,
    MemoryJarModule,
    StreaksModule,
    JournalModule,
    NotificationsModule,
    OccasionsModule,
    MemoryBooksModule,
    SearchModule,
    AdminModule,

    // ── Background workers ─────────────────────────────────────────────────
    WorkersModule,
  ],
  controllers: [HealthController],
  providers: [
    ActivityMiddleware,
    ConnectionMemberGuard,
    AdminGuard,
    RateLimitGuard,
  ],
  exports: [
    ConnectionMemberGuard,
    AdminGuard,
    RateLimitGuard,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(ActivityMiddleware)
      .exclude('v1/health', 'v1/auth/(.*)')
      .forRoutes('*');
  }
}
