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
        : { aiEnabled: true, openaiKey: 'test-only', model: 'configured-model' },
  };
  const search = {
    search: vi.fn(async () => [
      {
        id: 'result-one',
        title: 'Headphones',
        merchant: 'shop.example',
        url: 'https://shop.example/product',
        description: 'Merchant result',
        priceVerified: false,
        availabilityVerified: false,
        checkout: 'OFFICIAL_LINK',
      },
    ]),
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
  it('returns server-sourced merchant links without fabricated prices or purchase execution', async () => {
    const { agent, search } = setup();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response([call('find_goods', { query: 'headphones' })]))
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
        .mockImplementation(async () => response([call('find_goods', { query: 'headphones' })])),
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
