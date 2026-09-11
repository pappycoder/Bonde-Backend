import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_FILTER, Reflector } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { HealthModule } from './modules/health/health.module.js';
import { RedisModule, REDIS_CLIENT } from './common/redis/redis.module.js';
import { RedisThrottlerStorage } from './common/throttling/redis-throttler.storage.js';
import { CacheModule } from './common/cache/cache.module.js';
import { StorageModule } from './common/storage/storage.module.js';
import { MailModule } from './common/mail/mail.module.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { CommonModule } from './common/common.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ProfilesModule } from './modules/profiles/profiles.module.js';
import { OtpModule } from './modules/otp/otp.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { AuditLogModule } from './modules/audit/audit-log.module.js';
import { ActivityModule } from './modules/activity/activity.module.js';
import { CrudModule } from './modules/crud/crud.module.js';
import { AccountsModule } from './modules/accounts/accounts.module.js';
import { WalletsModule } from './modules/wallets/wallets.module.js';
import { CardsModule } from './modules/cards/cards.module.js';
import { ChatsModule } from './modules/chats/chats.module.js';
import { TransactionsModule } from './modules/transactions/transactions.module.js';
import { ThresholdsModule } from './modules/thresholds/thresholds.module.js';
import { BiometricsModule } from './modules/biometrics/biometrics.module.js';
import { SupabaseAuthGuard } from './modules/auth/guards/auth.guard.js';
import { RolesGuard } from './modules/auth/guards/roles.guard.js';
import configuration, { AppConfig } from './config/configuration.js';
import { envValidationSchema } from './config/env.validation.js';
import { STRICT_THROTTLE } from './common/throttling/strict-throttle.decorator.js';
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
      inject: [ConfigService, REDIS_CLIENT, Reflector],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        redisClient: RedisClient,
        reflector: Reflector,
      ) => {
        const throttle = config.get('throttle');
        return {
          throttlers: [
            {
              name: 'default',
              ttl: throttle.ttl,
              limit: throttle.limit,
              blockDuration: throttle.blockDuration,
            },
            {
              // Strict limits apply ONLY where handlers are marked
              // `@StrictThrottle()` (security-sensitive flows). skipIf ignores
              // it everywhere else, so existing endpoints are unaffected.
              name: 'strict',
              ttl: throttle.strict.ttl,
              limit: throttle.strict.limit,
              blockDuration: throttle.strict.blockDuration,
              skipIf: (context) => {
                const marked = reflector.getAllAndOverride<boolean>(STRICT_THROTTLE, [
                  context.getHandler(),
                  context.getClass(),
                ]);
                return marked !== true;
              },
            },
          ],
          storage: new RedisThrottlerStorage(redisClient),
        };
      },
    }),

    RedisModule,
    CacheModule,
    StorageModule,
    MailModule,
    HealthModule,
    PrismaModule,
    AuthModule,
    ProfilesModule,
    OtpModule,
    NotificationsModule,
    AuditLogModule,
    ActivityModule,
    CrudModule,
    AccountsModule,
    WalletsModule,
    CardsModule,
    ChatsModule,
    TransactionsModule,
    ThresholdsModule,
    BiometricsModule,
    CommonModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: SupabaseAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule {}
