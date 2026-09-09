import { ThrottlerStorage } from '@nestjs/throttler';
import { RedisClient } from '../redis/redis-client.interface.js';

/**
 * Shape returned by ThrottlerStorage.increment. Mirrors the record interface
 * consumed by the throttler guard's default tracker.
 */
export interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis-backed storage for @nestjs/throttler.
 *
 * Rate-limit counters and block state are stored as Redis keys with automatic
 * TTL expiry, so they never leak memory and work across multiple API instances.
 *
 * Key layout:
 *   `rate:{throttlerName}:{key}`              — request counter (INCR + PEXPIRE)
 *   `rate:block:{throttlerName}:{key}`        — block flag (SET + PEXPIRE)
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly client: RedisClient) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const counterKey = `rate:${throttlerName}:${key}`;
    const blockKey = `rate:block:${throttlerName}:${key}`;

    // Check if the IP is currently blocked before hitting the counter.
    const isBlockedNow = await this.client.exists(blockKey);
    if (isBlockedNow) {
      const blockTTL = await this.client.pttl(blockKey);
      return {
        totalHits: limit,
        timeToExpire: ttl,
        isBlocked: true,
        timeToBlockExpire: blockTTL > 0 ? blockTTL : blockDuration,
      };
    }

    // Atomically increment the counter and set its expiry on first hit.
    const totalHits = await this.client.incr(counterKey);
    if (totalHits === 1) {
      await this.client.pexpire(counterKey, ttl);
    }

    const timeToExpire = await this.client.pttl(counterKey);

    // If the user has hit the limit, set a block window.
    if (totalHits >= limit && blockDuration > 0) {
      const alreadyBlocked = await this.client.exists(blockKey);
      if (!alreadyBlocked) {
        await this.client.set(blockKey, '1', 'PX', blockDuration);
      }
      return {
        totalHits,
        timeToExpire: timeToExpire > 0 ? timeToExpire : ttl,
        isBlocked: true,
        timeToBlockExpire: blockDuration,
      };
    }

    return {
      totalHits,
      timeToExpire: timeToExpire > 0 ? timeToExpire : ttl,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}
