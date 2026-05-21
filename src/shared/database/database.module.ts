import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
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
      }),
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
