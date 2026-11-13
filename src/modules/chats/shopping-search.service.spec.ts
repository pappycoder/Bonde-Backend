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
const searchFetch = vi.fn(async () => response());
const productHtml = `<script type="application/ld+json">{"@type":"Product","name":"Headphones","description":"Product details","image":"https://shop.example/image.jpg","offers":{"price":"25000","priceCurrency":"NGN","availability":"https://schema.org/InStock"},"additionalProperty":[{"name":"Battery","value":"30 hours"}]}</script>`;
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
  searchFetch.mockReset();
  searchFetch.mockImplementation(async () => response());
  vi.stubGlobal('fetch', (url: string | URL) =>
    String(url).startsWith('https://api.search.brave.com/')
      ? searchFetch()
      : Promise.resolve(new Response(productHtml, { headers: { 'Content-Type': 'text/html' } })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('cached product discovery', () => {
  it('continues beyond the first three incomplete items to find five complete products', async () => {
    const { service, prisma } = setup();
    const visited: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const target = new URL(url);
      if (target.hostname === 'api.search.brave.com') {
        expect(target.searchParams.get('count')).toBe('20');
        return response(
          Array.from({ length: 8 }, (_, i) => ({
            title: `Item ${i}`,
            url: `https://shop.example/product/item-${i}`,
          })),
        );
      }
      visited.push(target.pathname);
      const index = Number(target.pathname.split('-').pop());
      const html = index < 3 ? productHtml.replace('"price":"25000",', '') : productHtml;
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    });
    const result = await service.search('owner', 'chat', 'headphones');
    expect(result.results).toHaveLength(5);
    expect(
      result.results.every(
        (row) =>
          row.amount &&
          row.imageUrl &&
          row.description &&
          row.availability === 'InStock' &&
          Object.keys(row.specifications ?? {}).length,
      ),
    ).toBe(true);
    expect(visited).toContain('/product/item-7');
    expect(prisma.shoppingResult.create).toHaveBeenCalledTimes(5);
  });
  it('follows more category item links when the early products have incomplete data', async () => {
    const { service } = setup();
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const target = new URL(url);
      if (target.hostname === 'api.search.brave.com')
        return response([{ url: 'https://shop.example/category/headphones', title: 'Category' }]);
      const html = target.pathname.startsWith('/category/')
        ? Array.from({ length: 9 }, (_, i) => `<a href="/product/item-${i}">Item</a>`).join('')
        : Number(target.pathname.split('-').pop()) < 4
          ? productHtml.replace('"image":"https://shop.example/image.jpg",', '')
          : productHtml;
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    });
    expect((await service.search('owner', 'chat', 'headphones')).results).toHaveLength(5);
  });
  it('searches every configured merchant and retains candidates from all of them', async () => {
    const { service, config } = setup();
    config.merchantHosts = ['one.example', 'two.example', 'three.example', 'four.example'];
    const searched: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const target = new URL(url);
      if (target.hostname === 'api.search.brave.com') {
        const host = target.searchParams.get('q')!.split('site:')[1];
        searched.push(host);
        return response([{ title: 'Headphones', url: `https://${host}/product/headphones` }]);
      }
      return new Response(productHtml, { headers: { 'Content-Type': 'text/html' } });
    });
    const result = await service.search('owner', 'chat', 'headphones');
    expect(searched.sort()).toEqual([...config.merchantHosts].sort());
    expect(new Set(result.results.map((row) => row.merchant))).toEqual(
      new Set(config.merchantHosts),
    );
    expect((await service.search('owner', 'chat', 'headphones')).results).toEqual(result.results);
  });
  it('excludes unavailable direct and linked items before saving or returning cards', async () => {
    const { service, prisma } = setup();
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const value = String(url);
      if (value.startsWith('https://api.search.brave.com/'))
        return response([
          { title: 'Sold out', url: 'https://shop.example/product/sold-out' },
          { title: 'Category', url: 'https://shop.example/category/headphones' },
        ]);
      const html = value.includes('/category/')
        ? '<a href="/product/discontinued">Old item</a><a href="/product/available">Available</a>'
        : productHtml.replace(
            'InStock',
            value.endsWith('sold-out')
              ? 'OutOfStock'
              : value.endsWith('discontinued')
                ? 'Discontinued'
                : 'InStock',
          );
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    });
    const result = await service.search('owner', 'chat', 'headphones');
    expect(result.results.map((row) => row.url)).toEqual([
      'https://shop.example/product/available',
    ]);
    expect(prisma.shoppingResult.create).toHaveBeenCalledOnce();
    expect((await service.search('owner', 'chat', 'headphones')).results).toEqual(result.results);
  });
  it('filters cached and recent offers carrying an unavailable stock signal', async () => {
    const { service, entries } = setup();
    const first = await service.search('owner', 'chat', 'headphones');
    const pageKey = `cache:shopping:page:${first.results[0].id}`;
    const entry = entries.get(pageKey)!;
    const details = JSON.parse(entry.value);
    entries.set(pageKey, {
      ...entry,
      value: JSON.stringify({ ...details, availability: 'SoldOut' }),
    });
    expect(await service.recent('owner', 'chat')).toEqual([]);
    const repaired = await service.search('owner', 'chat', 'headphones');
    expect(repaired.source).toBe('provider');
    expect(repaired.results.map((row) => row.id)).not.toContain(first.results[0].id);
  });
  it('follows product links from category results into individual detail pages', async () => {
    const { service } = setup();
    const visited: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const value = String(url);
      visited.push(value);
      if (value.startsWith('https://api.search.brave.com/'))
        return response([
          { title: 'Headphone category', url: 'https://shop.example/category/headphones' },
        ]);
      const html = value.includes('/category/')
        ? `<a href="/product/wireless-headphones-123">Headphones</a><a href="https://evil.example/product/other">Other</a><a href="/category/speakers">Speakers</a>`
        : productHtml;
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    });
    const result = await service.search('owner', 'chat', 'headphones');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      url: 'https://shop.example/product/wireless-headphones-123',
      title: 'Headphones',
      amount: '25000',
      detailsStatus: 'READ',
    });
    expect(visited).not.toContain('https://evil.example/product/other');
    expect(visited).not.toContain('https://shop.example/category/speakers');
  });
  it('excludes a linked product when its details cannot be read', async () => {
    const { service } = setup();
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const value = String(url);
      if (value.startsWith('https://api.search.brave.com/'))
        return response([{ title: 'Category', url: 'https://shop.example/category/headphones' }]);
      return value.includes('/category/')
        ? new Response('<a href="/product/wireless-headphones-123">View item</a>', {
            headers: { 'Content-Type': 'text/html' },
          })
        : new Response('Verify account', { status: 403 });
    });
    const result = await service.search('owner', 'chat', 'headphones');
    expect(result.results).toEqual([]);
  });
  it('follows allowed detail redirects and rejects listings and off-merchant redirects', async () => {
    const { service } = setup();
    const visited: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const value = String(url);
      visited.push(value);
      if (value.startsWith('https://api.search.brave.com/'))
        return response([
          { title: 'Item', url: 'https://shop.example/item' },
          { title: 'Category', url: 'https://shop.example/category' },
          { title: 'Redirect', url: 'https://shop.example/redirect' },
        ]);
      if (value.endsWith('/item'))
        return new Response(null, { status: 302, headers: { Location: '/product' } });
      if (value.endsWith('/redirect'))
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://evil.example/product' },
        });
      return new Response(
        value.endsWith('/category') ? '<html>Category listing</html>' : productHtml,
        { headers: { 'Content-Type': 'text/html' } },
      );
    });
    const result = await service.search('owner', 'chat', 'headphones');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      url: 'https://shop.example/product',
      detailsStatus: 'READ',
      amount: '25000',
      currency: 'NGN',
      availability: 'InStock',
    });
    expect(visited).not.toContain('https://evil.example/product');
  });
  it('excludes challenged item pages rather than adding incomplete cards', async () => {
    const { service, config } = setup();
    config.merchantHosts = ['jumia.com.ng'];
    vi.stubGlobal('fetch', async (url: string | URL) =>
      String(url).startsWith('https://api.search.brave.com/')
        ? response([
            { title: 'Headphones', url: 'https://www.jumia.com.ng/headphones-123.html' },
            { title: 'Search', url: 'https://www.jumia.com.ng/catalog/' },
          ])
        : new Response('Verify account', { status: 403 }),
    );
    const result = await service.search('owner', 'chat', 'headphones');
    expect(result.results).toEqual([]);
    expect((await service.search('owner', 'chat', 'headphones')).results).toEqual(result.results);
  });
  it('normalizes matching searches and preserves IDs, original timestamps, and unverified checkout labels', async () => {
    const { service, prisma, redis } = setup();
    const requests = vi.fn();
    const first = await service.search('owner', 'chat', '  Wireless   HEADPHONES ', {
      onProviderRequest: requests,
    });
    vi.setSystemTime(Date.now() + 30_000);
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
    expect(searchFetch).toHaveBeenCalledOnce();
    expect(requests).toHaveBeenCalledOnce();
    expect(prisma.shoppingResult.create).toHaveBeenCalledOnce();
    expect(redis.set.mock.calls.at(-1)![3]).toBe(60_000);
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
    expect(searchFetch).toHaveBeenCalledTimes(3);
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
    expect(searchFetch).toHaveBeenCalledTimes(6);
    expect(
      [...entries.keys()]
        .filter((k) => !k.startsWith('cache:shopping:page:'))
        .every((k) => /^cache:shopping:v8:[a-f0-9]{64}$/.test(k)),
    ).toBe(true);
  });
  it('coalesces concurrent searches and refreshes into one provider request', async () => {
    const { service } = setup();
    let deliver!: (value: Response) => void;
    searchFetch.mockImplementationOnce(
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
    expect(searchFetch).toHaveBeenCalledOnce();
    expect(requests).toHaveBeenCalledOnce();
  });
  it('caches empty results but never caches provider failures or invalid responses', async () => {
    const { service } = setup();
    searchFetch.mockResolvedValueOnce(response([]));
    expect((await service.search('owner', 'chat', 'nothing')).results).toEqual([]);
    expect((await service.search('owner', 'chat', 'nothing')).source).toBe('cache');
    const attempts = vi.fn();
    searchFetch.mockResolvedValueOnce(new Response('down', { status: 503 }));
    await expect(
      service.search('owner', 'chat', 'retry', { onProviderRequest: attempts }),
    ).rejects.toThrow('unavailable');
    expect((await service.search('owner', 'chat', 'retry')).source).toBe('provider');
    expect(attempts).toHaveBeenCalledOnce();
    searchFetch.mockResolvedValueOnce(new Response(JSON.stringify({ web: {} })));
    await expect(service.search('owner', 'chat', 'invalid')).rejects.toThrow('invalid results');
    expect((await service.search('owner', 'chat', 'invalid')).source).toBe('provider');
    expect(searchFetch).toHaveBeenCalledTimes(5);
  });
  it('does not grant access through poisoned cache IDs and filters recent results by owner, chat and current merchant hosts', async () => {
    const { service, entries, config, rows } = setup();
    const a = await service.search('owner', 'chat', 'headphones');
    const b = await service.search('other', 'other-chat', 'laptops');
    const firstKey = [...entries.keys()].find((key) => key.startsWith('cache:shopping:v8:'))!;
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
    searchFetch.mockClear();
    config.braveKey = '';
    config.braveEnabled = false;
    expect(await service.recent('owner', 'chat')).toHaveLength(10);
    expect(searchFetch).not.toHaveBeenCalled();
  });
  it('continues searching during a Redis outage without fabricating a cache hit', async () => {
    const { service, redis } = setup();
    redis.status = 'end';
    expect((await service.search('owner', 'chat', 'headphones')).source).toBe('provider');
    expect((await service.search('owner', 'chat', 'headphones')).source).toBe('provider');
    expect(searchFetch).toHaveBeenCalledTimes(2);
  });
  it('does not cancel another waiter when the initiating caller cancels', async () => {
    const { service } = setup();
    let deliver!: (value: Response) => void;
    searchFetch.mockImplementationOnce(
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
    expect(searchFetch).toHaveBeenCalledOnce();
  });
});
