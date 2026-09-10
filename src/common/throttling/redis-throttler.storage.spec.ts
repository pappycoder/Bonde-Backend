import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';
import type { RedisClient } from '../redis/redis-client.interface.js';

function failingClient(status: string): RedisClient {
  return {
    status,
    exists: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    incr: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    pexpire: vi.fn().mockResolvedValue(1),
    pttl: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    set: vi.fn().mockResolvedValue('OK'),
  } as unknown as RedisClient;
}

function healthyClient(status = 'ready'): RedisClient {
  return {
    status,
    exists: vi.fn().mockResolvedValue(0),
    incr: vi.fn().mockResolvedValue(1),
    pexpire: vi.fn().mockResolvedValue(1),
    pttl: vi.fn().mockResolvedValue(60_000),
    set: vi.fn().mockResolvedValue('OK'),
  } as unknown as RedisClient;
}

describe('RedisThrottlerStorage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates to Redis when the client is ready', async () => {
    const client = healthyClient();
    vi.mocked(client.incr).mockResolvedValue(1);
    const storage = new RedisThrottlerStorage(client);

    const record = await storage.increment('ip:1', 60_000, 100, 0, 'default');

    expect(client.incr).toHaveBeenCalledTimes(1);
    expect(client.pexpire).toHaveBeenCalledTimes(1);
    expect(record.totalHits).toBe(1);
    expect(record.isBlocked).toBe(false);
  });

  it('falls back to memory when Redis commands fail — never throws', async () => {
    const client = failingClient('ready');
    const storage = new RedisThrottlerStorage(client);

    const first = await storage.increment('ip:1', 60_000, 3, 0, 'default');
    const second = await storage.increment('ip:1', 60_000, 3, 0, 'default');

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(client.exists).toHaveBeenCalled();
  });

  it('bypasses Redis entirely when the client is not ready (fast path)', async () => {
    const client = failingClient('wait');
    const storage = new RedisThrottlerStorage(client);

    const record = await storage.increment('ip:1', 60_000, 3, 0, 'default');

    expect(client.exists).not.toHaveBeenCalled();
    expect(client.incr).not.toHaveBeenCalled();
    expect(record).toBeDefined();
    expect(record.isBlocked).toBe(false);
  });

  it('blocks a key only once the limit is exceeded while falling back', async () => {
    const client = failingClient('ready');
    const storage = new RedisThrottlerStorage(client);

    let record;
    for (let i = 0; i < 4; i++) {
      record = await storage.increment('ip:1', 60_000, 3, 10_000, 'default');
    }
    expect(record!.isBlocked).toBe(true);
  });
});
