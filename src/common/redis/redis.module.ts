import { Module, Global, OnModuleDestroy, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AppConfig } from '../../config/configuration.js';
import type { RedisClient } from './redis-client.interface.js';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/** Constructable form of the ioredis value (see factory below). */
type RedisConstructor = new (url?: string, options?: Record<string, unknown>) => RedisClient;

const RedisCtor: RedisConstructor = Redis as unknown as RedisConstructor;

/**
 * Guardrail for managed Redis providers that only accept TLS connections
 * (e.g. Upstash). A `redis://` URL against such a host silently dies at
 * runtime with `ECONNRESET`/`MaxRetriesPerRequestError`; we prefer a clear
 * bootstrap error. ioredis enables TLS automatically for `rediss://`.
 */
export function assertRedisUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`REDIS_URL is not a valid URL: "${url}"`);
  }

  if (parsed.hostname.endsWith('.upstash.io') && parsed.protocol !== 'rediss:') {
    throw new Error(
      `REDIS_URL must use the rediss:// scheme for TLS hosts (got "${parsed.protocol}//"). ` +
        'Upstash only accepts TLS connections.',
    );
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): RedisClient => {
        const url = config.get('redis').url;
        assertRedisUrl(url);

        const logger = new Logger('Redis');
        let wasErroring = false;

        const client = new RedisCtor(url, {
          // Commands issued before the first connect complete are queued and
          // flushed on `ready` (the default). On a dead connection they reject
          // after `maxRetriesPerRequest` with bounded backoff — the throttler
          // catches that and fails open instead of hanging the request.
          connectTimeout: 5000,
          maxRetriesPerRequest: 3,
          retryStrategy(times: number) {
            return Math.min(times * 200, 2000);
          },
        });

        client.on('error', (err: Error) => {
          // Log the first failure of an outage, then stay quiet until recovery —
          // ioredis emits one event per retry, which would spam the logs.
          if (!wasErroring) {
            wasErroring = true;
            logger.error('Redis connection error', err.stack);
          }
        });
        client.on('ready', () => {
          if (wasErroring) logger.log('Redis connection recovered');
          wasErroring = false;
        });
        client.on('reconnecting', () => {
          wasErroring = true;
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
