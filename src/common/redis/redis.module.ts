import { Module, Global, OnModuleDestroy, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AppConfig } from '../../config/configuration.js';
import type { RedisClient } from './redis-client.interface.js';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/** Constructable form of the ioredis value (see factory below). */
type RedisConstructor = new (url?: string, options?: Record<string, unknown>) => RedisClient;

const RedisCtor: RedisConstructor = Redis as unknown as RedisConstructor;

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): RedisClient => {
        const url = config.get('redis').url;

        const client = new RedisCtor(url, {
          maxRetriesPerRequest: 3,
          retryStrategy(times: number) {
            return Math.min(times * 200, 5000);
          },
          lazyConnect: true,
        });

        client.on('error', (err: Error) => {
          new Logger('Redis').error('Redis connection error', err.stack);
        });

        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: RedisClient) {}

  private readonly logger = new Logger('RedisModule');

  async onModuleDestroy() {
    this.logger.log('Closing Redis connection');
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
