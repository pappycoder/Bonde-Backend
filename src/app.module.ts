import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { HealthModule } from './health/health.module.js';
import { RedisModule, REDIS_CLIENT } from './common/redis/redis.module.js';
import { RedisThrottlerStorage } from './common/storage/redis-throttler.storage.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { CommonModule } from './common/common.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import configuration, { AppConfig } from './config/configuration.js';
import { envValidationSchema } from './config/env.validation.js';
import { RedisClient } from './common/redis/redis-client.interface.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
    }),

    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        pinoHttp: {
          level: config.get('nodeEnv') === 'production' ? 'info' : 'debug',
          transport:
            config.get('nodeEnv') !== 'production'
              ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
              : undefined,
        },
      }),
    }),

    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService, REDIS_CLIENT],
      useFactory: (config: ConfigService<AppConfig, true>, redisClient: RedisClient) => {
        const throttle = config.get('throttle');
        return {
          throttlers: [
            {
              ttl: throttle.ttl,
              limit: throttle.limit,
              blockDuration: throttle.blockDuration,
            },
          ],
          storage: new RedisThrottlerStorage(redisClient),
        };
      },
    }),

    RedisModule,
    HealthModule,
    CommonModule,
    PrismaModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule {}
