import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CacheService } from './cache.service.js';
import type { RedisClient } from '../redis/redis-client.interface.js';

function mockClient(overrides: Partial<RedisClient> = {}): RedisClient {
  return {
    status: 'ready',
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    scanIterator: vi.fn(),
    ...overrides,
  } as unknown as RedisClient;
}

function asyncIterable<T>(values: T[]): AsyncIterableIterator<T> {
  return (async function* () {
    for (const value of values) yield value;
  })();
}

describe('CacheService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips a JSON value with a TTL (PX)', async () => {
    const client = mockClient({
      get: vi.fn(async () => JSON.stringify({ a: 1 })),
    });
    const cache = new CacheService(client);

    const value = await cache.get<{ a: number }>('item:1');
    expect(value).toEqual({ a: 1 });
    expect(client.get).toHaveBeenCalledWith('cache:item:1');

    await cache.set('item:1', { b: 2 }, 5_000);
    expect(client.set).toHaveBeenCalledWith('cache:item:1', '{"b":2}', 'PX', 5_000);
  });

  it('treats a missing key as a miss', async () => {
    const cache = new CacheService(mockClient());
    await expect(cache.get('missing')).resolves.toBeUndefined();
  });

  it('treats a corrupt value as a miss', async () => {
    const client = mockClient({ get: vi.fn(async () => '{not-json') });
    const cache = new CacheService(client);
    await expect(cache.get('bad')).resolves.toBeUndefined();
  });

  it('getOrSet returns the cached value without calling the loader', async () => {
    const client = mockClient({
      get: vi.fn(async () => JSON.stringify('cached')),
    });
    const cache = new CacheService(client);
    const loader = vi.fn(async () => 'fresh');

    await expect(cache.getOrSet('k', 1_000, loader)).resolves.toBe('cached');
    expect(loader).not.toHaveBeenCalled();
  });

  it('getOrSet computes and stores on a miss', async () => {
    const cache = new CacheService(mockClient());
    const loader = vi.fn(async () => ({ n: 42 }));

    const value = await cache.getOrSet('k', 1_000, loader);
    expect(value).toEqual({ n: 42 });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('getOrSet single-flights concurrent loads for the same key', async () => {
    const loaders = new Map<string, (v: number) => void>();
    const client = mockClient(); // always a miss
    const cache = new CacheService(client);
    let calls = 0;
    const loader = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          calls += 1;
          loaders.set('k', resolve);
        }),
    );

    const p1 = cache.getOrSet('k', 1_000, loader);
    const p2 = cache.getOrSet('k', 1_000, loader);
    await new Promise((resolve) => setTimeout(resolve, 0));
    loaders.get('k')!(42);

    await expect(p1).resolves.toBe(42);
    await expect(p2).resolves.toBe(42);
    expect(calls).toBe(1);
  });

  it('invalidate scans for the namespaced pattern and deletes matches', async () => {
    const client = mockClient({
      scanIterator: vi.fn(() => asyncIterable(['cache:profiles:1', 'cache:profiles:2'])),
    });
    const cache = new CacheService(client);

    await cache.invalidate('profiles:*');

    expect(client.scanIterator).toHaveBeenCalledWith({ MATCH: 'cache:profiles:*', COUNT: 200 });
    expect(client.del).toHaveBeenCalledWith('cache:profiles:1', 'cache:profiles:2');
  });

  it('does not call del when nothing matched', async () => {
    const client = mockClient({ scanIterator: vi.fn(() => asyncIterable([])) });
    const cache = new CacheService(client);

    await cache.invalidate('nothing:*');
    expect(client.del).not.toHaveBeenCalled();
  });

  it('fails open when Redis is not ready — get is a miss, getOrSet still loads', async () => {
    const client = mockClient({ status: 'wait' });
    const cache = new CacheService(client);
    const loader = vi.fn(async () => 'fresh');

    await expect(cache.get('k')).resolves.toBeUndefined();
    await expect(cache.getOrSet('k', 1_000, loader)).resolves.toBe('fresh');
    expect(client.get).not.toHaveBeenCalled();
  });

  it('swallows redis errors and degrades to a miss / pass-through', async () => {
    const client = mockClient({
      get: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
      set: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    });
    const cache = new CacheService(client);

    await expect(cache.get('k')).resolves.toBeUndefined();
    await expect(cache.set('k', 1, 1_000)).resolves.toBeUndefined();
    await expect(cache.getOrSet('k', 1_000, async () => 'computed')).resolves.toBe('computed');
  });
});
