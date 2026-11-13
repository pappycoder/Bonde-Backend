import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiUsageService } from './ai-usage.service.js';

function setup(enabled = true) {
  const create = vi.fn(async ({ data }) => data);
  const update = vi.fn(async ({ data }) => data);
  const prisma = {
    aiUsageEvent: { create, update },
    aiUsageRate: { findFirst: vi.fn(async () => null) },
  };
  return {
    meter: new AiUsageService(prisma as never, { get: () => ({ enabled }) } as never),
    create,
    update,
  };
}
const context = { userId: 'owner', chatId: 'chat', model: 'configured-model' };
afterEach(() => vi.unstubAllGlobals());
describe('durable provider observations', () => {
  it('keeps the existing provider flow working before monitoring is activated', async () => {
    const { meter, create } = setup(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok')),
    );
    const response = await meter.fetch(
      'OPENAI',
      context,
      'https://api.openai.com/v1/responses',
      {},
    );
    expect(await response.text()).toBe('ok');
    expect(create).not.toHaveBeenCalled();
  });
  it('records intent before fetching and leaves the original response readable', async () => {
    const { meter, create, update } = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        expect(create).toHaveBeenCalledOnce();
        return new Response(JSON.stringify({ usage: { input_tokens: 12, output_tokens: 3 } }));
      }),
    );
    const result = await meter.fetch('OPENAI', context, 'https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: 'private prompt',
    });
    expect((await result.json()).usage.input_tokens).toBe(12);
    expect(update.mock.calls[0][0].data).toMatchObject({
      status: 'SUCCESS',
      inputTokens: 12,
      outputTokens: 3,
      costUsd: null,
    });
    expect(JSON.stringify(create.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(update.mock.calls)).not.toContain('private prompt');
  });
  it('does not make a paid call when durable recording is unavailable', async () => {
    const { meter, create } = setup();
    create.mockRejectedValueOnce(new Error('database unavailable'));
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      meter.fetch('OPENAI', context, 'https://api.openai.com/v1/responses', {}),
    ).rejects.toThrow('database unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains a distinct unknown-cost record when a provider times out', async () => {
    const { meter, create, update } = setup();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('request timed out')));
    await expect(meter.fetch('BRAVE', context, 'https://api.search.brave.com', {})).rejects.toThrow(
      'timed out',
    );
    expect(update.mock.calls[0][0].data.status).toBe('UNKNOWN');
    await expect(
      meter.fetch('BRAVE', context, 'https://api.search.brave.com', {}),
    ).rejects.toThrow();
    expect(create.mock.calls[0][0].data.id).not.toBe(create.mock.calls[1][0].data.id);
  });
});
