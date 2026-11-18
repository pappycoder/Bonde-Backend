import { BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shoppingDeadline } from './shopping-deadline.js';
import { ShoppingAgent } from './shopping-agent.js';
import { officialShoppingUrl } from './shopping-search.service.js';

const input = {
  userId: 'owner',
  chatId: 'chat',
  delivery: { deliveryAddress: null, recipient: null },
  messages: [{ role: 'USER', content: 'Find headphones' }],
};
function setup() {
  const config = {
    get: (key: string) =>
      key === 'nodeEnv'
        ? 'test'
        : {
            aiEnabled: true,
            openaiKey: 'test-only',
            model: 'configured-model',
            braveEnabled: true,
            braveKey: 'test-only',
            merchantHosts: ['shop.example'],
            servicesEnabled: true,
          },
  };
  const goods = [
    {
      id: 'result-one',
      title: 'Headphones',
      merchant: 'shop.example',
      url: 'https://shop.example/product',
      description: 'Merchant result',
      discoveredAt: '2026-11-06T09:00:00.000Z',
      priceVerified: false,
      availabilityVerified: false,
      checkout: 'OFFICIAL_LINK',
    },
  ];
  const search = {
    search: vi.fn(
      async (
        _userId: string,
        _chatId: string,
        _query: string,
        options: { onProviderRequest?: () => void },
      ) => {
        options.onProviderRequest?.();
        return { results: goods, source: 'provider' };
      },
    ),
    recent: vi.fn(async () => goods),
  };
  const services = { catalog: vi.fn(() => []), plans: vi.fn(), quote: vi.fn(), order: vi.fn() };
  return {
    agent: new ShoppingAgent(config as never, search as never, services as never),
    search,
    services,
  };
}
function call(name: string, args: unknown) {
  return { type: 'function_call', name, call_id: 'test-call', arguments: JSON.stringify(args) };
}
function response(output: unknown[]) {
  return new Response(JSON.stringify({ output, usage: { input_tokens: 10, output_tokens: 10 } }), {
    status: 200,
  });
}
afterEach(() => vi.unstubAllGlobals());
describe('bounded shopping agent', () => {
  it.each([
    ['spotify', 'https://www.spotify.com/premium/'],
    ['youtube-premium', 'https://www.youtube.com/premium'],
    ['apple-music', 'https://music.apple.com/'],
    ['prime-video', 'https://www.primevideo.com/'],
    ['google-one', 'https://one.google.com/about/plans'],
    ['microsoft-365', 'https://www.microsoft.com/microsoft-365'],
    ['canva-pro', 'https://www.canva.com/pricing/'],
    ['adobe-creative-cloud', 'https://www.adobe.com/creativecloud/plans.html'],
  ])(
    'returns only server-issued %s assistance through the dedicated tool',
    async (serviceId, checkoutUrl) => {
      const { agent, search, services } = setup();
      let step = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, request) => {
          const body = JSON.parse(request.body);
          if (step++ === 0)
            return response([
              call('prepare_subscription_checkout', {
                serviceId,
                countryCode: 'NG',
                intent: 'NEW',
              }),
            ]);
          const result = JSON.parse(
            body.input.findLast((entry: { type: string }) => entry.type === 'function_call_output')
              .output,
          );
          return response([
            call('finish_reply', {
              disposition: 'SHOPPING',
              text: 'Choose a plan at Spotify; activation is not verified.',
              resultIds: [],
              quoteIds: [],
              subscriptionIds: [result.id],
            }),
          ]);
        }),
      );
      const result = await agent.reply(input as never);
      expect(result.subscriptions).toHaveLength(1);
      expect(result.subscriptions![0]).toMatchObject({
        serviceId,
        checkoutUrl,
        activationStatus: 'UNVERIFIED',
        countryCode: 'NG',
      });
      expect(result.items).toEqual([]);
      expect(result.serviceQuotes).toEqual([]);
      expect(search.search).not.toHaveBeenCalled();
      expect(services.quote).not.toHaveBeenCalled();
    },
  );
  it('rejects invented subscription IDs in a final reply', async () => {
    const { agent } = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response([
          call('finish_reply', {
            disposition: 'SHOPPING',
            text: 'Netflix',
            resultIds: [],
            quoteIds: [],
            subscriptionIds: ['invented'],
          }),
        ]),
      ),
    );
    await expect(agent.reply(input as never)).rejects.toThrow('unknown offer');
  });
  it('compares the full merchant pool and returns the model-ranked best five with full details', async () => {
    const { agent, search } = setup();
    const goods = Array.from({ length: 8 }, (_, index) => ({
      id: `candidate-${index}`,
      title: `Headphones ${index}`,
      merchant: `merchant-${index % 4}.example`,
      url: `https://merchant-${index % 4}.example/product/${index}`,
      description: 'Full details. '.repeat(100),
      discoveredAt: '2026-11-06T09:00:00.000Z',
      priceVerified: false,
      availabilityVerified: false,
      checkout: 'OFFICIAL_LINK',
    }));
    search.search.mockResolvedValueOnce({ results: goods, source: 'provider' });
    const ranked = ['candidate-7', 'candidate-1', 'candidate-4', 'candidate-0', 'candidate-5'];
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          response([call('find_goods', { query: 'headphones', refresh: false })]),
        )
        .mockResolvedValueOnce(
          response([
            call('finish_reply', {
              disposition: 'SHOPPING',
              text: 'These five best fit your budget and specifications.',
              resultIds: ranked,
              quoteIds: [],
            }),
          ]),
        ),
    );
    const result = await agent.reply(input as never);
    expect(result.discoveries?.map((row) => row.id)).toEqual(ranked);
    expect(result.discoveries?.[0].description).toBe(goods[7].description);
    const request = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string);
    const toolOutput = request.input.find(
      (row: { type: string }) => row.type === 'function_call_output',
    );
    expect(JSON.parse(toolOutput.output)).toHaveLength(8);
    expect(
      request.tools.find((row: { name: string }) => row.name === 'finish_reply').parameters
        .properties.resultIds.maxItems,
    ).toBe(5);
  });
  it('returns server-sourced merchant links without fabricated prices or purchase execution', async () => {
    const { agent, search } = setup();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          response([call('find_goods', { query: 'headphones', refresh: false })]),
        )
        .mockResolvedValueOnce(
          response([
            call('finish_reply', {
              disposition: 'SHOPPING',
              text: 'Check the merchant for current stock and price.',
              resultIds: ['result-one'],
              quoteIds: [],
            }),
          ]),
        ),
    );
    const result = await agent.reply(input as never);
    expect(search.search).toHaveBeenCalledOnce();
    expect(result.discoveries?.[0]).toMatchObject({
      checkout: 'OFFICIAL_LINK',
      priceVerified: false,
    });
    expect(result.items).toEqual([]);
    expect(result.chargeable).toBe(true);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toMatchObject({
      reasoning: { effort: 'none' },
      store: false,
      max_output_tokens: 1800,
    });
  });
  it('still replies when search and service purchases are not configured', async () => {
    const search = { search: vi.fn() };
    const services = { catalog: vi.fn() };
    const agent = new ShoppingAgent(
      {
        get: (key: string) =>
          key === 'nodeEnv'
            ? 'test'
            : {
                aiEnabled: true,
                openaiKey: 'test',
                model: 'gpt-6-luna',
                braveEnabled: false,
                servicesEnabled: false,
              },
      } as never,
      search as never,
      services as never,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response([
          call('finish_reply', {
            disposition: 'SHOPPING',
            text: 'Live product search is not configured. What kind of laptop do you need?',
            resultIds: [],
            quoteIds: [],
          }),
        ]),
      ),
    );
    expect((await agent.reply(input as never)).text).toContain('not configured');
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual([
      'prepare_subscription_checkout',
      'read_order',
      'finish_reply',
    ]);
    expect(search.search).not.toHaveBeenCalled();
    expect(services.catalog).not.toHaveBeenCalled();
  });
  it('compares prior product results without another Brave request and preserves their timestamps', async () => {
    const { agent, search } = setup();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response([call('read_recent_goods', {})]))
        .mockResolvedValueOnce(
          response([
            call('finish_reply', {
              disposition: 'SHOPPING',
              text: 'Open the merchant checkout to confirm the price and buy these headphones.',
              resultIds: ['result-one'],
              quoteIds: [],
            }),
          ]),
        ),
    );
    const result = await agent.reply({
      ...input,
      messages: [{ role: 'USER', content: 'How do I buy the headphones you found?' }],
    } as never);
    expect(search.recent).toHaveBeenCalledWith('owner', 'chat');
    expect(search.search).not.toHaveBeenCalled();
    expect(result.discoveries?.[0]).toMatchObject({
      id: 'result-one',
      discoveredAt: '2026-11-06T09:00:00.000Z',
      checkout: 'OFFICIAL_LINK',
      priceVerified: false,
    });
    expect(result.usage).toMatchObject({ searches: 0, searchExecutions: 0, cacheHits: 0 });
    expect(result.chargeable).toBe(true);
    expect(result.items).toEqual([]);
  });
  it('distinguishes cached searches from paid requests and still limits search-tool executions to two', async () => {
    const { agent, search } = setup();
    search.search.mockImplementation(async () => ({ results: [], source: 'cache' }));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          response([call('find_goods', { query: 'headphones', refresh: false })]),
        )
        .mockResolvedValueOnce(
          response([
            call('finish_reply', {
              disposition: 'SHOPPING',
              text: 'No matching products were found.',
              resultIds: [],
              quoteIds: [],
            }),
          ]),
        )
        .mockImplementation(async () =>
          response([call('find_goods', { query: 'headphones', refresh: false })]),
        ),
    );
    expect((await agent.reply(input as never)).usage).toMatchObject({
      searches: 0,
      searchExecutions: 1,
      cacheHits: 1,
    });
    search.search.mockClear();
    await expect(agent.reply(input as never)).rejects.toMatchObject({
      shoppingUsage: { searches: 0, cacheHits: 2 },
    });
    expect(search.search).toHaveBeenCalledTimes(2);
  });
  it('passes explicit refresh through and records failed Brave attempts in usage', async () => {
    const { agent, search } = setup();
    search.search.mockImplementation(async (_user, _chat, _query, options) => {
      options.onProviderRequest?.();
      throw new Error('Brave unavailable');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response([call('find_goods', { query: 'headphones', refresh: true })])),
    );
    await expect(agent.reply(input as never)).rejects.toMatchObject({
      shoppingUsage: { searches: 1, searchExecutions: 1, cacheHits: 0 },
    });
    expect(search.search).toHaveBeenCalledWith(
      'owner',
      'chat',
      'headphones',
      expect.objectContaining({ refresh: true }),
    );
  });
  it('does not charge an unrelated response and refuses unknown tool calls', async () => {
    const { agent } = setup();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          response([
            call('finish_reply', {
              disposition: 'OFF_TOPIC',
              text: 'I can help with shopping and cable/data plans.',
              resultIds: [],
              quoteIds: [],
            }),
          ]),
        )
        .mockResolvedValueOnce(response([call('send_money', {})])),
    );
    expect((await agent.reply(input as never)).chargeable).toBe(false);
    await expect(agent.reply(input as never)).rejects.toThrow('unsupported action');
  });
  it('rejects fabricated quote references and enforces the search budget', async () => {
    const { agent, search } = setup();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          response([
            call('finish_reply', {
              disposition: 'SHOPPING',
              text: 'Buy this',
              resultIds: [],
              quoteIds: ['fabricated'],
            }),
          ]),
        )
        .mockImplementation(async () =>
          response([call('find_goods', { query: 'headphones', refresh: false })]),
        ),
    );
    await expect(agent.reply(input as never)).rejects.toThrow('unknown offer');
    await expect(agent.reply(input as never)).rejects.toThrow('search limit');
    expect(search.search).toHaveBeenCalledTimes(2);
  });
  it('bounds an adapter that ignores cancellation', async () => {
    const abort = new AbortController();
    const pending = shoppingDeadline(new Promise(() => undefined), abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow('timed out');
  });
  it('does not bill status-only assistance even if the model labels it SHOPPING', async () => {
    const { agent, services } = setup();
    services.order.mockResolvedValue({ status: 'SUCCEEDED' });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response([call('read_order', { orderId: 'owned-order' })]))
        .mockResolvedValueOnce(
          response([
            call('finish_reply', {
              disposition: 'SHOPPING',
              text: 'The provider confirmed delivery.',
              resultIds: [],
              quoteIds: [],
            }),
          ]),
        ),
    );
    expect((await agent.reply(input as never)).chargeable).toBe(false);
  });
  it('turns invalid beneficiary details into a bounded clarification', async () => {
    const { agent, services } = setup();
    services.quote.mockRejectedValue(new BadRequestException('Enter a valid phone number.'));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          response([
            call('prepare_service_quote', {
              serviceId: 'gotv',
              variationCode: 'plan',
              beneficiary: 'bad',
              phone: 'bad',
            }),
          ]),
        )
        .mockResolvedValueOnce(
          response([
            call('finish_reply', {
              disposition: 'SHOPPING',
              text: 'Please enter a valid Nigerian contact phone number.',
              resultIds: [],
              quoteIds: [],
            }),
          ]),
        ),
    );
    const result = await agent.reply(input as never);
    expect(result.chargeable).toBe(true);
    expect(result.serviceQuotes).toEqual([]);
  });
  it('allows only HTTPS merchant URLs within configured host boundaries', () => {
    expect(officialShoppingUrl('https://shop.example/product', ['shop.example'])).toBeTruthy();
    for (const url of [
      'http://shop.example/product',
      'https://shop.example.evil.test',
      'https://shop.example@evil.test',
      'javascript:alert(1)',
      'https://evil.test',
    ])
      expect(officialShoppingUrl(url, ['shop.example'])).toBeNull();
  });
});
