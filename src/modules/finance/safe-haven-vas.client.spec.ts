import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import fixtures from './fixtures/safe-haven-vas.json' with { type: 'json' };
import { SafeHavenVasClient, vasOutcome } from './safe-haven-vas.client.js';
import { ProviderError } from './providers.js';

function setup() {
  const finance = {
    environment: 'sandbox',
    safeHavenBaseUrl: 'https://api.sandbox.safehavenmfb.com',
    safeHavenClientId: 'test-client',
    safeHavenIssuer: 'test-issuer',
    safeHavenPrivateKey: 'test-key',
    treasuryAccountNumber: '0111111111',
    enabled: false,
    feesVerified: false,
    treasuryVerified: false,
    jobToken: '',
  };
  const shopping = { servicesEnabled: true };
  const client = {
    call: vi.fn(async (path: string) => {
      if (path === '/vas/services') return fixtures.services[0];
      if (path.includes('/service-categories')) return fixtures.categories.flat();
      if (path.includes('/products')) return fixtures.products;
      if (path === '/vas/verify') return fixtures.verify[0];
      if (path.startsWith('/accounts?'))
        return [
          {
            accountNumber: finance.treasuryAccountNumber,
            currencyCode: 'NGN',
            canDebit: true,
            status: 'Active',
            accountBalance: 10000,
          },
        ];
      if (path.startsWith('/vas/pay/')) return { status: 'successful' };
      throw new Error('Unexpected provider request');
    }),
  };
  const adapter = new SafeHavenVasClient(
    client as never,
    { get: (key: string) => (key === 'finance' ? finance : shopping) } as never,
  );
  return { adapter, client, finance, shopping };
}
afterEach(() => vi.restoreAllMocks());
describe('Safe Haven VAS', () => {
  it('reports invalid beneficiaries as correctable errors and provider outages as gateway failures', async () => {
    const { adapter, client } = setup();
    const original = client.call.getMockImplementation()!;
    client.call.mockImplementation(async (path) => {
      if (path === '/vas/verify') throw new ProviderError(true, 400);
      return original(path);
    });
    await expect(adapter.verify('gotv', '1212121212')).rejects.toMatchObject({ status: 400 });
    client.call.mockRejectedValue(new Error('network outage'));
    await expect(adapter.catalog()).rejects.toMatchObject({ status: 502 });
  });
  it('rejects variable, zero, malformed and uncoded plans rather than inventing a price', async () => {
    const { adapter, client } = setup();
    const original = client.call.getMockImplementation()!;
    client.call.mockImplementation(async (path) => {
      if (path.endsWith('/products'))
        return [
          { name: 'variable', bundleCode: 'v', amount: 100, isAmountFixed: false },
          { name: 'zero', bundleCode: 'z', amount: 0, isAmountFixed: true },
          { name: 'invalid', bundleCode: 'i', amount: 'not-money', isAmountFixed: true },
          { name: 'missing code', amount: 100, isAmountFixed: true },
        ] as never;
      return original(path);
    });
    expect(await adapter.plans('gotv')).toEqual([]);
  });
  it('maps documented service/category identifiers and fixed-price plans without sample fallbacks', async () => {
    const { adapter, client } = setup();
    expect(await adapter.catalog()).toEqual(
      expect.arrayContaining([
        { id: 'gotv', category: 'CABLE_TV', autoRenew: false },
        { id: 'etisalat-data', category: 'DATA', autoRenew: false },
      ]),
    );
    const [plan] = await adapter.plans('gotv');
    expect(plan).toMatchObject({
      code: 'gb1',
      amount: '13900.00',
      providerCategoryId: '61e98b6462d9b6a917f9302d',
      providerPlanCode: 'gb1',
    });
    client.call.mockImplementation(async (path) =>
      path === '/vas/services' ? [] : fixtures.products,
    );
    expect(await adapter.catalog()).toEqual([]);
    await expect(adapter.plans('gotv')).rejects.toThrow('unavailable');
  });
  it('requires a provider name for cable verification but never claims to verify data identity', async () => {
    const { adapter, client } = setup();
    expect(await adapter.verify('gotv', '1212121212')).toMatchObject({
      name: 'John Doe',
      verified: true,
    });
    expect(client.call).toHaveBeenCalledWith(
      '/vas/verify',
      'POST',
      expect.objectContaining({ entityNumber: '1212121212' }),
      undefined,
    );
    client.call.mockClear();
    expect(await adapter.verify('mtn-data', '08012345678')).toMatchObject({
      verified: false,
      verification: 'PHONE_FORMAT_ONLY',
    });
    expect(client.call.mock.calls.some(([path]) => path === '/vas/verify')).toBe(false);
  });
  it('uses treasury liquidity and immutable quote identifiers in a single purchase call', async () => {
    const { adapter, client } = setup();
    expect((await adapter.balance()).toFixed(2)).toBe('10000.00');
    await adapter.purchase('reference', {
      provider: 'SAFE_HAVEN',
      environment: 'sandbox',
      serviceId: 'gotv',
      providerCategoryId: 'category',
      providerPlanCode: 'gb1',
      amount: new Prisma.Decimal('13900.00'),
      beneficiary: '1212121212',
    } as never);
    expect(client.call).toHaveBeenCalledWith('/vas/pay/cable-tv', 'POST', {
      serviceCategoryId: 'category',
      bundleCode: 'gb1',
      amount: 13900,
      channel: 'WEB',
      debitAccountNumber: '0111111111',
      externalReference: 'reference',
      cardNumber: '1212121212',
    });
  });
  it('does not enable live purchases merely because credentials exist', () => {
    const { adapter, finance, shopping } = setup();
    shopping.servicesEnabled = false;
    expect(() => adapter.assertEnabled()).toThrow('not configured');
    shopping.servicesEnabled = true;
    finance.environment = 'production';
    expect(() => adapter.assertEnabled()).toThrow('not configured');
    finance.safeHavenBaseUrl = 'https://api.safehavenmfb.com';
    expect(() => adapter.assertPurchasesEnabled()).toThrow('approvals');
    Object.assign(finance, {
      enabled: true,
      feesVerified: true,
      treasuryVerified: true,
      jobToken: 'job-token',
    });
    expect(() => adapter.assertPurchasesEnabled()).not.toThrow();
  });
  it('normalizes authenticated lookup evidence and keeps unknown, mismatched and unreversed failures pending', () => {
    const data = fixtures.transaction[0];
    expect(vasOutcome(data, 'owned-reference')).toMatchObject({
      status: 'SUCCEEDED',
      reference: 'owned-reference',
      amount: '10000.00',
      beneficiary: '45036536519',
      categoryId: '61e98c4390dbbfc905f48f0d',
    });
    expect(vasOutcome({ ...data, externalReference: 'other' }, 'owned-reference').status).toBe(
      'PENDING',
    );
    expect(vasOutcome({ ...data, transactionStatus: 'failed' }, 'owned-reference').status).toBe(
      'PENDING',
    );
    expect(
      vasOutcome(
        { ...data, transactionStatus: 'failed', paymentStatus: 'REVERSED' },
        'owned-reference',
      ).status,
    ).toBe('FAILED');
    expect(vasOutcome({}, 'owned-reference').status).toBe('PENDING');
    expect(
      vasOutcome({ status: 'successful', amount: 1000, id: 'post-receipt' }, 'owned-reference')
        .status,
    ).toBe('PENDING');
  });
});
