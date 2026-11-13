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
      take: 10,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.flatMap((row) => this.view(row, hosts) ?? []);
  }
  private async cachedResults(value: unknown, userId: string, chatId: string, hosts: string[]) {
    const ids = object(value).ids;
    if (
      !Array.isArray(ids) ||
      ids.length > 10 ||
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
    return ids.flatMap((id: string) => this.view(byId.get(id)!, hosts) ?? []);
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
    const key = `shopping:v1:${hash}`;
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
        await this.cache.set(key, { ids: results.map((r) => r.id) }, SHOPPING_SEARCH_TTL_MS);
        return results;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return { results: await wait(work), source: 'provider' };
  }
  private async fetchResults(
    userId: string,
    chatId: string,
    query: string,
    hosts: string[],
    key: string,
    onProviderRequest?: () => void,
  ): Promise<ShoppingDiscoveryDto[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set(
      'q',
      `${query} Nigeria (${hosts.map((host) => `site:${host}`).join(' OR ')})`,
    );
    url.searchParams.set('count', '10');
    onProviderRequest?.();
    const request: RequestInit = {
      headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
      // One cancelled waiter must not cancel another waiter's shared provider load.
      signal: AbortSignal.timeout(15_000),
    };
    const response = this.meter
      ? await this.meter.fetch('BRAVE', { userId, chatId, model: 'brave-search' }, url, request)
      : await fetch(url, request);
    if (!response.ok) throw new BadGatewayException('Product search is temporarily unavailable.');
    const rows = object(object(await response.json()).web).results;
    if (!Array.isArray(rows))
      throw new BadGatewayException('Product search returned invalid results.');
    const results: ShoppingDiscoveryDto[] = [];
    const seen = new Set<string>();
    for (const raw of rows.slice(0, 10)) {
      const row = object(raw);
      const source = officialShoppingUrl(string(row.url), hosts);
      if (!source || seen.has(source) || !string(row.title).trim()) continue;
      seen.add(source);
      const result = await this.prisma.shoppingResult.create({
        data: {
          id: randomUUID(),
          userId,
          chatId,
          title: string(row.title).slice(0, 300),
          merchant: new URL(source).hostname,
          url: source,
          description: string(row.description).slice(0, 1000),
        },
      });
      results.push(this.view(result, hosts)!);
    }
    return results;
  }
}
