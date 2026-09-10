import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from './redis-throttler.storage.js';

interface MemoryBucket {
  count: number;
  expiresAt: number;
  blockedUntil: number;
}

/**
 * Per-process, in-memory fallback for rate limiting.
 *
 * Used by `RedisThrottlerStorage` when the Redis connection is unavailable so
 * the API keeps rejecting abusive traffic (degraded, not wide open) without
 * depending on a backing store. Limits apply per process — sufficient as a
 * temporary safety net, never for horizontal scaling.
 *
 * Buckets expire lazily: we only clean up an entry when the same key is seen
 * again, keeping bookkeeping O(rows created) and lock-free for a single
 * Node.js event loop.
 */
export class MemoryThrottlerStorage implements ThrottlerStorage {
  private readonly buckets = new Map<string, MemoryBucket>();

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const bucketKey = `${throttlerName}:${key}`;
    const now = Date.now();
    const bucket = this.buckets.get(bucketKey);

    const isBlocked = bucket !== undefined && bucket.blockedUntil > now;
    if (bucket === undefined || (bucket.expiresAt <= now && !isBlocked)) {
      this.buckets.set(bucketKey, { count: 1, expiresAt: now + ttl, blockedUntil: now });
      return { totalHits: 1, timeToExpire: ttl, isBlocked: false, timeToBlockExpire: 0 };
    }

    if (isBlocked) {
      return {
        totalHits: limit,
        timeToExpire: bucket.expiresAt - now,
        isBlocked: true,
        timeToBlockExpire: bucket.blockedUntil - now,
      };
    }

    bucket.count += 1;

    // Block only once the limit is EXCEEDED — the request that reaches exactly
    // `limit` is still allowed (framework semantics: "blocked if it exceeds").
    const hitsExceeded = bucket.count > limit && blockDuration > 0;
    if (hitsExceeded) bucket.blockedUntil = now + blockDuration;

    return {
      totalHits: bucket.count,
      timeToExpire: bucket.expiresAt - now,
      isBlocked: hitsExceeded,
      timeToBlockExpire: hitsExceeded ? blockDuration : 0,
    };
  }
}
