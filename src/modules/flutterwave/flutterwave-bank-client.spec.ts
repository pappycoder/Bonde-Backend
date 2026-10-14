import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlutterwaveClient } from './flutterwave.client.js';
import { FlutterwaveError } from './flutterwave.errors.js';

function client() {
  return new FlutterwaveClient({
    get: () => ({ baseUrl: 'https://provider.example/v3', secretKey: 'test-key' }),
  } as never);
}
afterEach(() => vi.unstubAllGlobals());
describe('Flutterwave bank transport', () => {
  it('uses the NG bank endpoint and normalizes codes', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ status: 'success', data: [{ name: 'Access Bank', code: '044' }] }),
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(await client().listBanks()).toEqual([{ name: 'Access Bank', code: '044' }]);
    expect(fetcher).toHaveBeenCalledWith(
      'https://provider.example/v3/banks/NG',
      expect.objectContaining({ method: 'GET' }),
    );
  });
  it('posts the account resolve contract and maps provider fields', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 'success',
            data: { account_number: '0690000034', account_name: 'Verified Owner' },
          }),
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(await client().resolveBankAccount('044', '0690000034')).toEqual({
      accountNumber: '0690000034',
      accountName: 'Verified Owner',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://provider.example/v3/accounts/resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ account_bank: '044', account_number: '0690000034' }),
      }),
    );
  });
  it.each([
    { account_number: 'another-number', account_name: 'Owner' },
    { account_number: '0690000034', account_name: '' },
  ])('rejects mismatched or missing provider account details', async (data) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'success', data }))),
    );
    await expect(client().resolveBankAccount('044', '0690000034')).rejects.toBeInstanceOf(
      FlutterwaveError,
    );
  });
});
