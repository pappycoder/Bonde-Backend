import { describe, it, expect } from 'vitest';
import { MemoryThrottlerStorage } from './memory-throttler.storage.js';

describe('MemoryThrottlerStorage', () => {
  it('increments a counter and reports remaining TTL', async () => {
    const storage = new MemoryThrottlerStorage();
    const first = await storage.increment('ip:1', 60_000, 10, 0, 'default');
    expect(first).toMatchObject({ totalHits: 1, isBlocked: false, timeToBlockExpire: 0 });

    const second = await storage.increment('ip:1', 60_000, 10, 0, 'default');
    expect(second.totalHits).toBe(2);
    expect(second.timeToExpire).toBeGreaterThan(0);
    expect(second.timeToExpire).toBeLessThanOrEqual(60_000);
  });

  it('blocks only once the limit is exceeded', async () => {
    const storage = new MemoryThrottlerStorage();
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await storage.increment('ip:1', 60_000, 3, 5_000, 'default'));
    }
    expect(results[2].isBlocked).toBe(false);
    expect(results[2].totalHits).toBe(3);
    expect(results[3].isBlocked).toBe(true);
    expect(results[3].totalHits).toBe(4);
    expect(results[3].timeToBlockExpire).toBeGreaterThan(0);
    expect(results[3].timeToBlockExpire).toBeLessThanOrEqual(5_000);
  });

  it('keeps an IP blocked until the block window lapses', async () => {
    const storage = new MemoryThrottlerStorage();
    for (let i = 0; i < 3; i++) {
      await storage.increment('ip:1', 100, 3, 100, 'default');
    }
    const duringBlock = await storage.increment('ip:1', 100, 3, 100, 'default');
    expect(duringBlock.isBlocked).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 120));
    const afterBlock = await storage.increment('ip:1', 100, 3, 100, 'default');
    expect(afterBlock.isBlocked).toBe(false);
    expect(afterBlock.totalHits).toBe(1);
  });

  it('expires counters lazily after the TTL', async () => {
    const storage = new MemoryThrottlerStorage();
    await storage.increment('ip:1', 50, 100, 0, 'default');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const after = await storage.increment('ip:1', 50, 100, 0, 'default');
    expect(after.totalHits).toBe(1);
  });

  it('namespaces keys per throttler', async () => {
    const storage = new MemoryThrottlerStorage();
    await storage.increment('ip:1', 60_000, 1, 0, 'default');
    const other = await storage.increment('ip:1', 60_000, 1, 0, 'strict');
    expect(other.totalHits).toBe(1);
  });
});
