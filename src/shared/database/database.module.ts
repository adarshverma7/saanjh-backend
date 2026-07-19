import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

const logger = new Logger('DatabaseModule');

/**
 * Neon serverless Postgres autosuspends compute after idle and silently kills
 * TCP connections held by clients. Against the DIRECT endpoint this surfaces
 * as random ECONNRESET / timeout 500s — the "database keeps breaking" pattern.
 *
 * Neon's POOLED endpoint (host with `-pooler`) fronts PgBouncer, which absorbs
 * suspend/resume cycles. This helper upgrades a direct Neon host to the pooled
 * one so the app is resilient no matter which URL the environment carries.
 * Set NEON_DIRECT=1 to opt out (e.g. for debugging).
 */
function toPooledNeonUrl(url: string | undefined): string | undefined {
  if (!url || process.env.NEON_DIRECT === '1') return url;
  if (!url.includes('.neon.tech') || url.includes('-pooler')) return url;
  const upgraded = url.replace(/@(ep-[a-z0-9-]+)\./, '@$1-pooler.');
  if (upgraded !== url) {
    logger.log('Using Neon pooled endpoint for runtime connections');
  }
  return upgraded;
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: toPooledNeonUrl(config.get<string>('DATABASE_URL')),
        ssl:
          config.get<string>('NODE_ENV') === 'production'
            ? { rejectUnauthorized: false }
            : false,
        entities: [__dirname + '/entities/*.entity{.ts,.js}'],
        migrations: [__dirname + '/migrations/*{.ts,.js}'],
        synchronize: false,
        logging: config.get<string>('NODE_ENV') === 'development',
        // Run migrations automatically on startup in production
        migrationsRun: config.get<string>('NODE_ENV') === 'production',
        // Keep retrying the initial connection during Neon cold-resume.
        retryAttempts: 15,
        retryDelay: 3000,
        // node-postgres pool hygiene: drop idle sockets before Neon kills
        // them, keep live ones alive, and never hang forever on checkout.
        extra: {
          max: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 10_000,
          keepAlive: true,
          keepAliveInitialDelayMillis: 5_000,
        },
        // A connection dropped mid-idle must log, never crash the process.
        poolErrorHandler: (err: Error) =>
          logger.warn(`pg pool connection dropped (recovered): ${err.message}`),
      }),
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
