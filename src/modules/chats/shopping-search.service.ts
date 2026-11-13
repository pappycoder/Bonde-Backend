import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ShoppingResult } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { CacheService } from '../../common/cache/cache.service.js';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { object, string } from '../finance/shopping-values.js';
import type { ShoppingDiscoveryDto } from './chat-replies.dto.js';
import { shoppingDeadline } from './shopping-deadline.js';
import { isCompleteProduct, parseProductPage, type ProductPage } from './product-page.js';
import { AiUsageService } from '../ai-monitoring/ai-usage.service.js';

export const SHOPPING_SEARCH_TTL_MS = 30 * 60_000;
interface CachedSearch {
  ids: string[];
}
export interface ShoppingSearchOptions {
  refresh?: boolean;
  signal?: AbortSignal;
  /** Called immediately before a real provider request, including failed attempts. */
  onProviderRequest?: () => void;
}
export interface ShoppingSearchBatch {
  results: ShoppingDiscoveryDto[];
  source: 'provider' | 'cache' | 'coalesced';
}

export function officialShoppingUrl(value: string, hosts: string[]) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
      ? url.href
      : null;
  } catch {
    return null;
  }
}

async function mapPages<T, R>(rows: T[], read: (row: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, rows.length) }, async () => {
      while (index < rows.length) {
        const position = index++;
        results[position] = await read(rows[position]);
      }
    }),
  );
  return results;
}

/** Recognize detail routes without treating category/search pages as items. */
export function isProductDetailUrl(value: string): boolean {
  const url = new URL(value);
  const path = url.pathname;
  if (/(^|\/)(catalog|category|categories|search|brand|brands|merchant)(\/|$)/i.test(path))
    return false;
  return /\/(?:products?|dp|gp\/product)\/[^/]+/i.test(path) || /-[0-9]+\.html$/i.test(path);
}

export function productLinks(html: string, base: string, hosts: string[]): string[] {
  const links = new Set<string>();
  // Links rendered by the merchant, including JSON hydration/JSON-LD URLs.
  for (const match of html.matchAll(/(?:href\s*=\s*["']|"url"\s*:\s*")([^"'<>\s]+)/gi)) {
    try {
      const raw = match[1].replace(/&amp;/g, '&').replace(/\\\//g, '/');
      const source = officialShoppingUrl(new URL(raw, base).href, hosts);
      if (source && isProductDetailUrl(source)) links.add(source);
    } catch {
      /* Ignore malformed merchant links. */
    }
    if (links.size >= 20) break;
  }
  return [...links];
}

@Injectable()
export class ShoppingSearch {
  private readonly inflight = new Map<string, Promise<ShoppingDiscoveryDto[]>>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly cache: CacheService,
    @Optional() private readonly meter?: AiUsageService,
  ) {}
  private hosts() {
    return [
      ...new Set(
        this.config
          .get('shopping', { infer: true })
          .merchantHosts.map((host) => host.trim().toLowerCase())
          .filter(Boolean),
      ),
    ].sort();
  }
  private view(row: ShoppingResult, hosts: string[]): ShoppingDiscoveryDto | null {
    const url = officialShoppingUrl(row.url, hosts);
    if (!url) return null;
    return {
      id: row.id,
      title: row.title,
      merchant: new URL(url).hostname,
      url,
      description: row.description,
      discoveredAt: row.createdAt.toISOString(),
      priceVerified: false,
      availabilityVerified: false,
      checkout: 'OFFICIAL_LINK',
    };
  }
  async recent(userId: string, chatId: string): Promise<ShoppingDiscoveryDto[]> {
    const hosts = this.hosts();
    if (!hosts.length) return [];
    const rows = await this.prisma.shoppingResult.findMany({
      where: { userId, chatId },
      take: 50,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const results = await Promise.all(
      rows.flatMap((row) => this.view(row, hosts) ?? []).map((row) => this.withDetails(row)),
    );
    return results
      .filter((row) => row.detailsStatus === 'READ' && isCompleteProduct(row))
      .slice(0, 10);
  }
  private async cachedResults(value: unknown, userId: string, chatId: string, hosts: string[]) {
    const ids = object(value).ids;
    if (
      !Array.isArray(ids) ||
      ids.length > Math.max(10, hosts.length * 40) ||
      ids.some(
        (id) =>
          typeof id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
      )
    )
      return undefined;
    if (!ids.length) return [];
    // Never trust cache IDs as an ownership grant, or recreate evidence on a cache hit.
    const rows = await this.prisma.shoppingResult.findMany({
      where: { userId, chatId, id: { in: ids } },
    });
    if (rows.length !== ids.length) return undefined;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const results = await Promise.all(
      ids
        .flatMap((id: string) => this.view(byId.get(id)!, hosts) ?? [])
        .map((row) => this.withDetails(row)),
    );
    const complete = results.filter(
      (row) => row.detailsStatus === 'READ' && isCompleteProduct(row),
    );
    return complete.length === results.length ? complete : undefined;
  }
  async search(
    userId: string,
    chatId: string,
    query: string,
    options: ShoppingSearchOptions = {},
  ): Promise<ShoppingSearchBatch> {
    options.signal?.throwIfAborted();
    const c = this.config.get('shopping', { infer: true });
    const hosts = this.hosts();
    if (!c.braveEnabled || !c.braveKey || !hosts.length)
      throw new ServiceUnavailableException('Product search is not configured.');
    const normalized = query
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .slice(0, 300);
    if (!normalized) throw new BadRequestException('Enter a product to search for.');
    const hash = createHash('sha256')
      .update(JSON.stringify({ userId, chatId, query: normalized, hosts }))
      .digest('hex');
    const key = `shopping:v8:${hash}`;
    const wait = (work: Promise<ShoppingDiscoveryDto[]>) =>
      options.signal ? shoppingDeadline(work, options.signal) : work;
    const active = this.inflight.get(key);
    if (active) return { results: await wait(active), source: 'coalesced' };
    if (!options.refresh) {
      const cached = await this.cachedResults(
        await this.cache.get<CachedSearch>(key),
        userId,
        chatId,
        hosts,
      );
      options.signal?.throwIfAborted();
      // A concurrent refresh takes precedence over an older cache read.
      const refreshing = this.inflight.get(key);
      if (refreshing) return { results: await wait(refreshing), source: 'coalesced' };
      if (cached !== undefined) return { results: cached, source: 'cache' };
    }
    options.signal?.throwIfAborted();
    const work = this.fetchResults(
      userId,
      chatId,
      normalized,
      hosts,
      c.braveKey,
      options.onProviderRequest,
    )
      .then(async (results) => {
        await this.cache.set(
          key,
          { ids: results.map((r) => r.id) },
          results.length >= 5 ? SHOPPING_SEARCH_TTL_MS : 60_000,
        );
        return results;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return { results: await wait(work), source: 'provider' };
  }
  private async withDetails(row: ShoppingDiscoveryDto): Promise<ShoppingDiscoveryDto> {
    const details = await this.cache.get<
      ProductPage & { detailsStatus?: 'READ' | 'BROWSER_REQUIRED' }
    >(`shopping:page:${row.id}`);
    return details ? { ...row, ...details, detailsStatus: details.detailsStatus ?? 'READ' } : row;
  }
  private async readPage(
    source: string,
    hosts: string[],
    budget?: AbortSignal,
  ): Promise<{ url: string; details: ProductPage | null; itemUrls: string[] } | null> {
    try {
      let current = source;
      const signal = budget
        ? AbortSignal.any([budget, AbortSignal.timeout(8000)])
        : AbortSignal.timeout(8000);
      signal.throwIfAborted();
      for (let redirects = 0; redirects < 4; redirects++) {
        const response = await fetch(current, {
          redirect: 'manual',
          signal,
          headers: { Accept: 'text/html' },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const next = officialShoppingUrl(
            new URL(response.headers.get('location') ?? '', current).href,
            hosts,
          );
          await response.body?.cancel();
          if (!next) return null;
          current = next;
          continue;
        }
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
          await response.body?.cancel();
          return null;
        }
        const reader = response.body?.getReader();
        if (!reader) return null;
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 2_000_000) return null;
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        const html = Buffer.concat(chunks).toString('utf8');
        return {
          url: current,
          details: parseProductPage(html, current),
          itemUrls: productLinks(html, current, hosts),
        };
      }
    } catch {
      /* Merchant challenges or outages require an in-app browser handoff. */
    }
    return null;
  }
  private async fetchResults(
    userId: string,
    chatId: string,
    query: string,
    hosts: string[],
    key: string,
    onProviderRequest?: () => void,
  ): Promise<ShoppingDiscoveryDto[]> {
    // Search each merchant so one site's category pages cannot crowd out
    // another merchant's individual products. Interleave their ranked results.
    const batches = await Promise.all(
      hosts.map(async (host) => {
        const url = new URL('https://api.search.brave.com/res/v1/web/search');
        url.searchParams.set('q', `${query} Nigeria site:${host}`);
        url.searchParams.set('count', '20');
        onProviderRequest?.();
        const request: RequestInit = {
          headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        };
        const response = this.meter
          ? await this.meter.fetch('BRAVE', { userId, chatId, model: 'brave-search' }, url, request)
          : await fetch(url, request);
        if (!response.ok)
          throw new BadGatewayException('Product search is temporarily unavailable.');
        const rows = object(object(await response.json()).web).results;
        if (!Array.isArray(rows))
          throw new BadGatewayException('Product search returned invalid results.');
        return rows.slice(0, 20);
      }),
    );
    const results: ShoppingDiscoveryDto[] = [];
    const budget = AbortSignal.timeout(30_000);
    const identity = (value: string) => {
      const url = new URL(value);
      url.hash = '';
      for (const key of Array.from(url.searchParams.keys()))
        if (/^(utm_|cid$|gclid$|fbclid$)/i.test(key)) url.searchParams.delete(key);
      url.searchParams.sort();
      return url.href;
    };
    const scheduled = new Set<string>();
    const queues = hosts.map(() => [] as string[]);
    const enqueue = (index: number, value: unknown, front = false) => {
      const url = officialShoppingUrl(string(value), hosts);
      if (!url) return;
      const key = identity(url);
      if (scheduled.has(key)) return;
      scheduled.add(key);
      if (front) queues[index].unshift(url);
      else queues[index].push(url);
    };
    batches.forEach((batch, index) => batch.forEach((raw) => enqueue(index, object(raw).url)));
    const attempted = hosts.map(() => 0);
    const candidates: Array<{ url: string; details: ProductPage; detailsStatus: 'READ' }> = [];
    const seen = new Set<string>();
    const candidateKeys = new Set<string>();
    // Give each merchant a turn. Follow item links ahead of further category
    // pages and replenish rejected candidates until there is a comparison pool.
    while (!budget.aborted && candidates.length < 10) {
      const next = queues.flatMap((queue, index) => {
        if (attempted[index] >= 40) return [];
        return queue.splice(0, 2).map((url) => {
          attempted[index]++;
          return { url, index };
        });
      });
      if (!next.length) break;
      const pages = await mapPages(next, async (item) => ({
        ...item,
        page: await this.readPage(item.url, hosts, budget),
      }));
      for (const { page, index } of pages) {
        if (!page) continue;
        if (isCompleteProduct(page.details)) {
          const key = identity(page.url);
          if (!candidateKeys.has(key)) {
            candidateKeys.add(key);
            candidates.push({ url: page.url, details: page.details!, detailsStatus: 'READ' });
          }
        } else if (!isProductDetailUrl(page.url)) {
          for (const url of [...page.itemUrls].reverse()) enqueue(index, url, true);
        }
      }
    }
    for (const candidate of candidates) {
      if (!candidate) continue;
      const { details, detailsStatus, url: source } = candidate;
      if (seen.has(source)) continue;
      seen.add(source);
      const result = await this.prisma.shoppingResult.create({
        data: {
          id: randomUUID(),
          userId,
          chatId,
          title: details.title,
          merchant: new URL(source).hostname,
          url: source,
          description: details.description,
        },
      });
      await this.cache.set(
        `shopping:page:${result.id}`,
        { ...details, detailsStatus },
        SHOPPING_SEARCH_TTL_MS,
      );
      results.push({ ...this.view(result, hosts)!, ...details, detailsStatus });
    }
    return results;
  }
}
