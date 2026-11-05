import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { object, string } from '../finance/shopping-values.js';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}
  async search(userId: string, chatId: string, query: string, signal?: AbortSignal) {
    const c = this.config.get('shopping', { infer: true });
    if (!c.braveEnabled || !c.braveKey || !c.merchantHosts.length)
      throw new ServiceUnavailableException('Product search is not configured.');
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set(
      'q',
      `${query.slice(0, 300)} Nigeria (${c.merchantHosts.map((host) => `site:${host}`).join(' OR ')})`,
    );
    url.searchParams.set('count', '10');
    const response = await fetch(url, {
      headers: { 'X-Subscription-Token': c.braveKey, Accept: 'application/json' },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new BadGatewayException('Product search is temporarily unavailable.');
    const rows = object(object(await response.json()).web).results;
    if (!Array.isArray(rows))
      throw new BadGatewayException('Product search returned invalid results.');
    const results = [];
    const seen = new Set<string>();
    for (const raw of rows.slice(0, 10)) {
      const row = object(raw);
      const source = officialShoppingUrl(string(row.url), c.merchantHosts);
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
      results.push({
        id: result.id,
        title: result.title,
        merchant: result.merchant,
        url: result.url,
        description: result.description,
        priceVerified: false,
        availabilityVerified: false,
        checkout: 'OFFICIAL_LINK',
      });
    }
    return results;
  }
}
