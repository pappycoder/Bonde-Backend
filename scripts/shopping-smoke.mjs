import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { CacheService } from '../dist/common/cache/cache.service.js';
import { assertRedisUrl } from '../dist/common/redis/redis.module.js';
import configuration from '../dist/config/configuration.js';
import { ShoppingAgent } from '../dist/modules/chats/shopping-agent.js';
import { ShoppingSearch } from '../dist/modules/chats/shopping-search.service.js';
import { SafeHavenClient } from '../dist/modules/finance/providers.js';
import { SafeHavenVasClient } from '../dist/modules/finance/safe-haven-vas.client.js';
import { ServicePurchases } from '../dist/modules/finance/service-purchases.service.js';

// Explicit, paid smoke test. No Nest application, Postgres connection, workers,
// passcode proof or purchase endpoint. Search evidence and quotes stay in memory.
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.join('=')];
  }),
);
const settings = configuration();
const productsOnly = Object.hasOwn(args, 'products-only');
const missing = [
  'OPENAI_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'SHOPPING_MERCHANT_HOSTS',
  ...(!productsOnly ? ['SAFE_HAVEN_CLIENT_ID', 'SAFE_HAVEN_ISSUER', 'SAFE_HAVEN_PRIVATE_KEY'] : []),
].filter((key) => !process.env[key]?.trim());
if (missing.length) {
  console.error(
    `Missing smoke-test configuration: ${missing.join(', ')}. No provider calls were made.`,
  );
  process.exit(1);
}
if (
  !productsOnly &&
  (settings.finance.environment !== 'sandbox' ||
    settings.finance.safeHavenBaseUrl !== 'https://api.sandbox.safehavenmfb.com')
) {
  console.error(
    'This smoke test requires Safe Haven sandbox configuration. No provider calls were made.',
  );
  process.exit(1);
}
if (!productsOnly && !/^(?:0[789]\d{9}|234[789]\d{9})$/.test(args.phone ?? '')) {
  console.error(
    'Pass --phone=<Nigerian test number> for a sandbox data quote. No provider calls were made.',
  );
  process.exit(1);
}
settings.shopping.aiEnabled = true;
settings.shopping.servicesEnabled = !productsOnly;
settings.finance.enabled = false;
settings.nodeEnv = 'development';
const config = new ConfigService(settings);
// Require a working cache before making any paid provider call.
try {
  assertRedisUrl(settings.redis.url);
} catch {
  console.error('Redis configuration is invalid. No provider calls were made.');
  process.exit(1);
}
const redis = new Redis(settings.redis.url, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
  connectTimeout: 5000,
});
redis.on('error', () => {}); // Never log connection URLs or credentials.
try {
  await redis.connect();
} catch {
  console.error(
    'Redis is unavailable. Start Redis before this cache-verifying smoke test. No provider calls were made.',
  );
  redis.disconnect();
  process.exit(1);
}
const evidence = [];
const memory = {
  shoppingResult: {
    create: async ({ data }) => {
      const row = { ...data, createdAt: new Date() };
      evidence.push(row);
      return row;
    },
    findMany: async ({ where, take }) => {
      const rows = evidence
        .filter(
          (r) =>
            r.userId === where.userId &&
            r.chatId === where.chatId &&
            (!where.id || where.id.in.includes(r.id)),
        )
        .toSorted((a, b) => b.createdAt - a.createdAt);
      return take ? rows.slice(0, take) : rows;
    },
  },
  serviceQuote: { create: async ({ data }) => data },
};
const safe = new SafeHavenClient(config);
const adapter = new SafeHavenVasClient(safe, config);
// Both layers refuse purchase paths even if the implementation later changes.
const originalCall = safe.call.bind(safe);
safe.call = (path, ...rest) => {
  if (!(
    path === '/vas/services' ||
    /^\/vas\/service\/[^/]+\/service-categories$/.test(path) ||
    /^\/vas\/service-category\/[^/]+\/products$/.test(path) ||
    path === '/vas/verify'
  ))
    throw new Error('Smoke test blocked a non-read/quote provider endpoint.');
  return originalCall(path, ...rest);
};
adapter.purchase = async () => {
  throw new Error('Purchases are forbidden in the smoke test.');
};
const services = new ServicePurchases(memory, adapter, null, null, config);
const search = new ShoppingSearch(memory, config, new CacheService(redis));
let lastProductSearch;
const originalSearch = search.search.bind(search);
search.search = async (userId, chatId, query, options) => {
  const batch = await originalSearch(userId, chatId, query, options);
  lastProductSearch = { userId, chatId, query, batch };
  return batch;
};
const agent = new ShoppingAgent(config, search, services);
const input = {
  userId: randomUUID(),
  chatId: randomUUID(),
  delivery: { deliveryAddress: null, recipient: null },
};
let failures = 0;
async function check(name, work) {
  const start = performance.now();
  try {
    const detail = await work();
    console.log(
      JSON.stringify({
        check: name,
        ok: true,
        latencyMs: Math.round(performance.now() - start),
        ...detail,
      }),
    );
  } catch (error) {
    failures++;
    // Do not print request bodies, credentials, beneficiary numbers or provider responses.
    console.error(
      JSON.stringify({
        check: name,
        ok: false,
        latencyMs: Math.round(performance.now() - start),
        error: error instanceof Error ? error.message : 'Smoke test failed',
        usage: error?.shoppingUsage,
      }),
    );
  }
}
async function reply(content) {
  return agent.reply({
    ...input,
    messages: [{ role: 'USER', content }],
    signal: AbortSignal.timeout(60_000),
  });
}
try {
  await check('AI clarification', async () => {
    const result = await reply(
      'I want to buy a laptop. Ask me about my budget and intended use before searching.',
    );
    if (!result.text?.trim() || result.discoveries.length || result.serviceQuotes.length)
      throw new Error('Expected a clarification without offers.');
    return { model: settings.shopping.model, usage: result.usage };
  });
  await check('Live product discovery', async () => {
    const result = await reply(
      'Search the configured official merchants for wireless headphones under NGN 100000. Return sourced links; do not invent prices.',
    );
    if (!result.discoveries.length || !result.usage.searches)
      throw new Error('No sourced product results found; check merchant allowlist/query.');
    if (result.discoveries.some((r) => r.priceVerified || r.availabilityVerified))
      throw new Error('Search evidence was incorrectly marked verified.');
    return { results: result.discoveries.length, usage: result.usage };
  });
  await check('Repeated product search uses Redis', async () => {
    if (!lastProductSearch) throw new Error('The product discovery check did not run a search.');
    const { userId, chatId, query, batch } = lastProductSearch;
    let providerRequests = 0;
    const repeated = await originalSearch(userId, chatId, query, {
      onProviderRequest: () => {
        providerRequests++;
      },
    });
    if (
      repeated.source !== 'cache' ||
      providerRequests ||
      JSON.stringify(repeated.results) !== JSON.stringify(batch.results)
    )
      throw new Error(
        'An identical search did not reuse the original product evidence from Redis.',
      );
    return { cacheHit: true, braveRequests: providerRequests, results: repeated.results.length };
  });
  if (!productsOnly)
    await check('Safe Haven sandbox plans and AI quote', async () => {
      const catalog = await services.catalog();
      const serviceId = args.service || catalog.find((r) => r.id.endsWith('-data'))?.id;
      if (!serviceId?.endsWith('-data'))
        throw new Error('Choose an available data service using --service=mtn-data.');
      const plans = await services.plans(serviceId);
      if (!plans.length)
        throw new Error('Safe Haven returned no purchasable plans for the selected service.');
      const plan = plans[0];
      const quote = await services.quote(input.userId, {
        serviceId,
        variationCode: plan.code,
        beneficiary: args.phone,
        phone: args.phone,
      });
      if (quote.amount !== plan.amount)
        throw new Error('Quote does not match current provider pricing.');
      const result = await reply(
        `Prepare a quote only for ${serviceId}, plan code ${plan.code}, beneficiary ${args.phone}, contact phone ${args.phone}. Do not purchase.`,
      );
      if (!result.serviceQuotes.length) throw new Error('The AI did not return a sandbox quote.');
      return {
        serviceId,
        planCount: plans.length,
        quoteCount: result.serviceQuotes.length,
        usage: result.usage,
        persistence: 'memory-only',
        purchaseSubmitted: false,
      };
    });
  process.exitCode = failures ? 1 : 0;
} finally {
  await redis.quit().catch(() => redis.disconnect());
}
