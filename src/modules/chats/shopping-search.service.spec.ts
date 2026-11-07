import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShoppingResult } from '@prisma/client';
import { CacheService } from '../../common/cache/cache.service.js';
import { SHOPPING_SEARCH_TTL_MS, ShoppingSearch } from './shopping-search.service.js';

function setup() {
  const entries = new Map<string, { value: string; expires: number }>();
  const redis = {
    status: 'ready',
    get: vi.fn(async (key: string) => {
      const entry = entries.get(key);
      return entry && entry.expires > Date.now() ? entry.value : null;
    }),
    set: vi.fn(async (key: string, value: string, _px: string, ttl: number) => {
      entries.set(key, { value, expires: Date.now() + ttl });
      return 'OK';
    }),
  };
  const config = { braveEnabled: true, braveKey: 'test-key', merchantHosts: ['shop.example'] };
  const rows: ShoppingResult[] = [];
  const prisma = {
    shoppingResult: {
      create: vi.fn(async ({ data }: { data: Omit<ShoppingResult, 'createdAt'> }) => {
        const row = { ...data, createdAt: new Date() };
        rows.push(row);
        return row;
      }),
      findMany: vi.fn(
        async ({
          where,
          take,
          orderBy,
        }: {
          where: { userId: string; chatId: string; id?: { in: string[] } };
          take?: number;
          orderBy?: unknown;
        }) => {
          let selected = rows.filter(
            (r) =>
              r.userId === where.userId &&
              r.chatId === where.chatId &&
              (!where.id || where.id.in.includes(r.id)),
          );
          if (orderBy)
            selected = selected.sort(
              (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
            );
          return take ? selected.slice(0, take) : selected;
        },
      ),
    },
  };
  const cache = new CacheService(redis as never);
  const service = new ShoppingSearch(prisma as never, { get: () => config } as never, cache);
  return { service, config, rows, redis, entries, prisma };
}
function response(
  results: unknown[] = [
    {
      title: 'Headphones',
      url: 'https://shop.example/product',
      description: 'Check the merchant for price and availability.',
    },
  ],
) {
  return new Response(JSON.stringify({ web: { results } }), { status: 200 });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-06T09:00:00Z'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response()),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('cached product discovery', () => {
  it('normalizes matching searches and preserves IDs, original timestamps, and unverified checkout labels', async () => {
    const { service, prisma, redis } = setup();
    const requests = vi.fn();
    const first = await service.search('owner', 'chat', '  Wireless   HEADPHONES ', {
      onProviderRequest: requests,
    });
    vi.setSystemTime(Date.now() + 5 * 60_000);
    const second = await service.search('owner', 'chat', 'wireless headphones', {
      onProviderRequest: requests,
    });
    expect(first.source).toBe('provider');
    expect(second).toEqual({ results: first.results, source: 'cache' });
    expect(second.results[0]).toMatchObject({
      discoveredAt: '2026-11-06T09:00:00.000Z',
      checkout: 'OFFICIAL_LINK',
      priceVerified: false,
      availabilityVerified: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(requests).toHaveBeenCalledOnce();
    expect(prisma.shoppingResult.create).toHaveBeenCalledOnce();
    expect(redis.set.mock.calls[0][3]).toBe(SHOPPING_SEARCH_TTL_MS);
  });
  it('fetches again after expiry and bypasses a valid cache on explicit refresh', async () => {
    const { service } = setup();
    const first = await service.search('owner', 'chat', 'headphones');
    const fresh = await service.search('owner', 'chat', 'headphones', { refresh: true });
    expect(fresh.source).toBe('provider');
    expect(fresh.results[0].id).not.toBe(first.results[0].id);
    expect((await service.search('owner', 'chat', 'headphones')).results).toEqual(fresh.results);
    vi.setSystemTime(Date.now() + SHOPPING_SEARCH_TTL_MS + 1);
    expect((await service.search('owner', 'chat', 'headphones')).source).toBe('provider');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('scopes cache keys to user, chat, query and canonical merchant allowlist', async () => {
    const { service, config, entries } = setup();
    for (const [owner, chat, query] of [
      ['owner', 'chat', 'headphones'],
      ['other', 'chat', 'headphones'],
      ['owner', 'other-chat', 'headphones'],
      ['owner', 'chat', 'laptops'],
    ])
      expect((await service.search(owner, chat, query)).source).toBe('provider');
    config.merchantHosts = ['second.example', 'shop.example'];
    await service.search('owner', 'chat', 'headphones');
    config.merchantHosts = ['SHOP.EXAMPLE', 'second.example', 'shop.example'];
    expect((await service.search('owner', 'chat', 'headphones')).source).toBe('cache');
    expect(fetch).toHaveBeenCalledTimes(5);
    expect([...entries.keys()].every((k) => /^cache:shopping:v1:[a-f0-9]{64}$/.test(k))).toBe(true);
  });
  it('coalesces concurrent searches and refreshes into one provider request', async () => {
    const { service } = setup();
    let deliver!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const requests = vi.fn();
    const first = service.search('owner', 'chat', 'headphones', {
      refresh: true,
      onProviderRequest: requests,
    });
    const second = service.search('owner', 'chat', 'headphones', {
      refresh: true,
      onProviderRequest: requests,
    });
    deliver(response());
    const [a, b] = await Promise.all([first, second]);
    expect(a.source).toBe('provider');
    expect(b).toEqual({ results: a.results, source: 'coalesced' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(requests).toHaveBeenCalledOnce();
  });
  it('caches empty results but never caches provider failures or invalid responses', async () => {
    const { service } = setup();
    vi.mocked(fetch).mockResolvedValueOnce(response([]));
    expect((await service.search('owner', 'chat', 'nothing')).results).toEqual([]);
    expect((await service.search('owner', 'chat', 'nothing')).source).toBe('cache');
    const attempts = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(new Response('down', { status: 503 }));
    await expect(
      service.search('owner', 'chat', 'retry', { onProviderRequest: attempts }),
    ).rejects.toThrow('unavailable');
    expect((await service.search('owner', 'chat', 'retry')).source).toBe('provider');
    expect(attempts).toHaveBeenCalledOnce();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ web: {} })));
    await expect(service.search('owner', 'chat', 'invalid')).rejects.toThrow('invalid results');
    expect((await service.search('owner', 'chat', 'invalid')).source).toBe('provider');
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it('does not grant access through poisoned cache IDs and filters recent results by owner, chat and current merchant hosts', async () => {
    const { service, entries, config, rows } = setup();
    const a = await service.search('owner', 'chat', 'headphones');
    const b = await service.search('other', 'other-chat', 'laptops');
    const firstKey = [...entries.keys()][0];
    entries.set(firstKey, {
      value: JSON.stringify({ ids: [b.results[0].id] }),
      expires: Date.now() + SHOPPING_SEARCH_TTL_MS,
    });
    const repaired = await service.search('owner', 'chat', 'headphones');
    expect(repaired.source).toBe('provider');
    expect(repaired.results.map((r) => r.id)).not.toContain(b.results[0].id);
    expect((await service.recent('owner', 'chat')).map((r) => r.id)).toContain(a.results[0].id);
    expect(await service.recent('owner', 'other-chat')).toEqual([]);
    config.merchantHosts = ['other.example'];
    expect(await service.recent('owner', 'chat')).toEqual([]);
    config.merchantHosts = ['shop.example'];
    rows[0].url = 'https://shop.example.evil.test/product';
    expect((await service.recent('owner', 'chat')).map((r) => r.id)).not.toContain(a.results[0].id);
  });
  it('returns at most ten recent results without Brave credentials or outbound calls', async () => {
    const { service, config } = setup();
    for (let n = 0; n < 12; n++) {
      await service.search('owner', 'chat', `item ${n}`);
      vi.setSystemTime(Date.now() + 1000);
    }
    vi.mocked(fetch).mockClear();
    config.braveKey = '';
    config.braveEnabled = false;
    expect(await service.recent('owner', 'chat')).toHaveLength(10);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('continues searching during a Redis outage without fabricating a cache hit', async () => {
    const { service, redis } = setup();
    redis.status = 'end';
    expect((await service.search('owner', 'chat', 'headphones')).source).toBe('provider');
    expect((await service.search('owner', 'chat', 'headphones')).source).toBe('provider');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not cancel another waiter when the initiating caller cancels', async () => {
    const { service } = setup();
    let deliver!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const abort = new AbortController();
    const first = service.search('owner', 'chat', 'headphones', {
      refresh: true,
      signal: abort.signal,
    });
    const rejected = expect(first).rejects.toThrow('timed out');
    const second = service.search('owner', 'chat', 'headphones');
    abort.abort();
    deliver(response());
    await rejected;
    expect((await second).results).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
