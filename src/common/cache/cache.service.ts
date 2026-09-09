import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS_CLIENT } from '../redis/redis.module.js';
import type { RedisClient } from '../redis/redis-client.interface.js';

const KEY_PREFIX = 'cache:';

/**
 * Cache-aside helper over the shared Redis client.
 *
 * Values are JSON-serialized; keys are namespaced under `cache:` and TTL is
 * enforced via `PX`. `getOrSet` deduplicates in-flight loads **per process**
 * (single-flight) so a cold key is computed once under concurrency.
 *
 * Degradation contract (mirrors the throttler): a Redis outage must never fail
 * a request. `get`/`invalidate` return empty results and `set`/`getOrSet`
 * degrade to computing the value, logging once per outage.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger('CacheService');
  private readonly inflight = new Map<string, Promise<unknown>>();
  private warnedOffline = false;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.safeGet(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Corrupt value: treat as a miss and let it be overwritten.
      this.logger.warn(`Discarding corrupt cache value for "${key}"`);
      return undefined;
    }
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    if (!this.available()) {
      this.warnOffline();
      return;
    }
    try {
      await this.redis.set(this.prefix(key), JSON.stringify(value), 'PX', ttlMs);
      this.markOnline();
    } catch (error) {
      this.warnOffline(error);
    }
  }

  async del(key: string): Promise<void> {
    if (!this.available()) {
      this.warnOffline();
      return;
    }
    try {
      await this.redis.del(this.prefix(key));
    } catch (error) {
      this.warnOffline(error);
    }
  }

  /**
   * Removes every key matching a `cache:`-namespaced glob pattern via SCAN
   * (never KEYS, which would block the server). Use for coarse invalidation,
   * e.g. `invalidate('profiles:*')`.
   */
  async invalidate(pattern: string): Promise<void> {
    if (!this.available()) {
      this.warnOffline();
      return;
    }
    try {
      const keys: string[] = [];
      for await (const key of this.redis.scanIterator({
        MATCH: `${KEY_PREFIX}${pattern}`,
        COUNT: 200,
      })) {
        keys.push(key);
      }
      if (keys.length > 0) await this.redis.del(...keys);
    } catch (error) {
      this.warnOffline(error);
    }
  }

  /**
   * Return the cached value, or compute + store it when absent. Concurrent
   * callers for the same key share one load (single-flight within this
   * process).
   */
  async getOrSet<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = loader()
      .then(async (value) => {
        await this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  private async safeGet(key: string): Promise<string | undefined> {
    if (!this.available()) {
      this.warnOffline();
      return undefined;
    }
    try {
      const raw = await this.redis.get(this.prefix(key));
      this.markOnline();
      return raw ?? undefined;
    } catch (error) {
      this.warnOffline(error);
      return undefined;
    }
  }

  private prefix(key: string): string {
    return `${KEY_PREFIX}${key}`;
  }

  private available(): boolean {
    return this.redis.status === 'ready';
  }

  private warnOffline(error?: unknown): void {
    if (this.warnedOffline) return;
    this.warnedOffline = true;
    this.logger.warn(
      'Redis unavailable — cache degraded (misses pass through to source):',
      error instanceof Error ? error.stack : undefined,
    );
  }

  private markOnline(): void {
    if (this.warnedOffline) {
      this.warnedOffline = false;
      this.logger.log('Cache back on Redis');
    }
  }
}
