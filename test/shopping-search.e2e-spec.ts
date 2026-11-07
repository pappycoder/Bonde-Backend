import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ShoppingSearch } from '../src/modules/chats/shopping-search.service.js';
import { ChatWorker } from '../src/modules/chats/chat-worker.service.js';
import { ChatTurnsService } from '../src/modules/chats/chat-turns.service.js';
import { ServicePurchases } from '../src/modules/finance/service-purchases.service.js';
import {
  bootE2EApp,
  SEED_CHAT_ID,
  SEED_USER_ID,
  SEED_OTHER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

describe('Product evidence and Redis reuse (e2e)', () => {
  let ctx: BootedE2EApp;
  let search: ShoppingSearch;
  let previousRedis: string | undefined;
  beforeAll(async () => {
    previousRedis = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://127.0.0.1:6379/6';
    ctx = await bootE2EApp();
    ctx.app.get(ChatWorker).onModuleDestroy();
    ctx.app.get(ChatTurnsService).onModuleDestroy();
    ctx.app.get(ServicePurchases).onModuleDestroy();
    const config = ctx.app.get(ConfigService);
    config.set('shopping', {
      ...config.get('shopping'),
      braveEnabled: true,
      braveKey: 'test-only',
      merchantHosts: ['shop.example'],
    });
    search = ctx.app.get(ShoppingSearch);
  });
  afterAll(async () => {
    await ctx?.close();
    if (previousRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedis;
  });
  beforeEach(async () => {
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              web: {
                results: [
                  {
                    title: 'Headphones',
                    url: 'https://shop.example/headphones',
                    description: 'Check final details on the merchant site.',
                  },
                ],
              },
            }),
          ),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reuses the same persisted evidence through real Redis, isolates owners, and replaces cached results on refresh', async () => {
    const query = `headphones ${randomUUID()}`;
    const first = await search.search(SEED_USER_ID, SEED_CHAT_ID, query);
    const again = await search.search(SEED_USER_ID, SEED_CHAT_ID, query);
    expect(again).toEqual({ results: first.results, source: 'cache' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(await ctx.prisma.shoppingResult.count()).toBe(1);
    const stored = await ctx.prisma.shoppingResult.findUniqueOrThrow({
      where: { id: first.results[0].id },
    });
    expect(again.results[0]).toMatchObject({
      discoveredAt: stored.createdAt.toISOString(),
      checkout: 'OFFICIAL_LINK',
      priceVerified: false,
      availabilityVerified: false,
    });
    expect(await search.recent(SEED_OTHER_ID, SEED_CHAT_ID)).toEqual([]);
    const otherChat = await ctx.prisma.chat.create({
      data: { id: randomUUID(), userId: SEED_OTHER_ID, title: 'Other shopping' },
    });
    const other = await search.search(SEED_OTHER_ID, otherChat.id, query);
    expect(other.source).toBe('provider');
    expect(other.results[0].id).not.toBe(first.results[0].id);
    expect((await search.recent(SEED_USER_ID, SEED_CHAT_ID)).map((r) => r.id)).toEqual([
      first.results[0].id,
    ]);
    const refreshed = await search.search(SEED_USER_ID, SEED_CHAT_ID, query, { refresh: true });
    expect(refreshed.source).toBe('provider');
    expect(refreshed.results[0].id).not.toBe(first.results[0].id);
    expect((await search.search(SEED_USER_ID, SEED_CHAT_ID, query)).results).toEqual(
      refreshed.results,
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await ctx.prisma.financeJournal.count()).toBe(0);
  });
  it('persists no evidence for a failed provider attempt and retries instead of caching the error', async () => {
    const query = `retry ${randomUUID()}`;
    vi.mocked(fetch).mockResolvedValueOnce(new Response('down', { status: 503 }));
    await expect(search.search(SEED_USER_ID, SEED_CHAT_ID, query)).rejects.toThrow('unavailable');
    expect(await ctx.prisma.shoppingResult.count()).toBe(0);
    const retried = await search.search(SEED_USER_ID, SEED_CHAT_ID, query);
    expect(retried.source).toBe('provider');
    expect(retried.results).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
