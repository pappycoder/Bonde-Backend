import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { FinanceAuthorizations } from './finance-authorizations.service.js';
const d = (n: number) => new Prisma.Decimal(n);
function setup(rule: Record<string, unknown> = {}, reason: string | null = null) {
  const card = {
    id: 'card',
    userId: 'owner',
    status: 'ACTIVE',
    expirationDate: new Date('2099-01-01'),
    user: { accounts: [{ isActive: true }] },
    locks: [],
  };
  const tx = {
    $queryRaw: vi.fn(),
    card: {
      findFirst: vi.fn(async () => card),
      findUniqueOrThrow: vi.fn(async () => card),
      update: vi.fn(),
    },
    financeAuthorization: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(),
      count: vi.fn(async () => 1),
      findFirst: vi.fn(async () => null),
    },
    financeOperation: { count: vi.fn(async () => 0) },
    financeCustomer: { findUnique: vi.fn(async () => ({ status: 'READY' })) },
    financeAccount: { findUnique: vi.fn(async () => ({ balance: d(100) })) },
    transactionThreshold: { findUnique: vi.fn(async () => null) },
  };
  const policy = {
    snapshot: vi.fn(async () => ({ rule, reason, uses: 1, spent: d(0), controlsValid: true })),
  };
  const merchants = {
    observe: vi.fn(async () => ({ id: 'identity', revokedAt: null })),
    candidate: vi.fn(),
  };
  const retirement = { mark: vi.fn() };
  const ledger = { post: vi.fn() };
  const prisma = { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)) };
  return {
    tx,
    policy,
    merchants,
    retirement,
    ledger,
    service: new FinanceAuthorizations(
      prisma as never,
      ledger as never,
      { assertCurrency: vi.fn() } as never,
      policy as never,
      merchants as never,
      retirement as never,
    ),
  };
}
const raw = {
  _id: 'authorization',
  card: { _id: 'provider' },
  pendingRequest: { currency: 'NGN', amount: 20 },
  merchant: { merchantId: 'MID', country: 'NG', name: 'Store', category: '5411' },
};
describe('authorization enforcement at checkout', () => {
  it('declines and captures merchant evidence before any allocation check or binding', async () => {
    const { service, merchants, tx, ledger } = setup({
      type: 'MERCHANT',
      merchantIds: [],
      pendingMerchantLabel: 'Store',
    });
    expect((await service.authorize(raw)).data.responseCode).toBe('05');
    expect(tx.financeAuthorization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DECLINED',
          merchantIdentityId: 'identity',
          requestType: 'PURCHASE',
        }),
      }),
    );
    expect(merchants.candidate).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ id: 'card' }),
      expect.objectContaining({ id: 'identity' }),
      'authorization',
      expect.objectContaining({ identityId: 'identity', amount: '20.00' }),
    );
    expect(tx.financeAccount.findUnique).not.toHaveBeenCalled();
    expect(ledger.post).not.toHaveBeenCalled();
  });
  it('does not let purchase approval bypass hard merchant/category rules', async () => {
    const { service, tx } = setup({ type: 'CATEGORY', categories: ['GROCERIES'] });
    expect(
      (await service.authorize({ ...raw, merchant: { ...raw.merchant, category: '4511' } })).data
        .responseCode,
    ).toBe('05');
    expect(tx.financeAuthorization.findFirst).not.toHaveBeenCalled();
  });
  it('accepts zero-value verification without holds or consuming a reserved purchase slot', async () => {
    const { service, ledger, tx } = setup({ type: 'SELF_DESTRUCT', usageLimit: 1 });
    expect(
      (
        await service.authorize({
          ...raw,
          pendingRequest: { currency: 'NGN', amount: 0, merchantAmount: 0 },
        })
      ).data.responseCode,
    ).toBe('00');
    expect(ledger.post).not.toHaveBeenCalled();
    expect(tx.financeAuthorization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requestType: 'VERIFICATION', status: 'VERIFIED' }),
      }),
    );
  });
  it('preserves real verification-fee holds without counting them as purchases', async () => {
    const { service, ledger, tx } = setup({ type: 'SELF_DESTRUCT', usageLimit: 1 });
    expect(
      (
        await service.authorize({
          ...raw,
          pendingRequest: { currency: 'NGN', amount: 1, merchantAmount: 0 },
        })
      ).data.responseCode,
    ).toBe('00');
    expect(ledger.post).toHaveBeenCalledTimes(1);
    expect(tx.financeAuthorization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requestType: 'VERIFICATION', status: 'HELD' }),
      }),
    );
  });
  it('declines incomplete control records instead of authorizing a standard purchase', async () => {
    const { service, policy, ledger } = setup();
    policy.snapshot.mockResolvedValueOnce({
      rule: {},
      reason: null,
      uses: 0,
      spent: d(0),
      controlsValid: false,
    });
    expect((await service.authorize(raw)).data.responseCode).toBe('05');
    expect(ledger.post).not.toHaveBeenCalled();
  });
  it('records retirement and declines at expiry even before the scheduled cleanup runs', async () => {
    const { service, retirement, ledger } = setup({}, 'TIME_EXPIRED');
    expect((await service.authorize(raw)).data.responseCode).toBe('05');
    expect(retirement.mark).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'card' }),
      'TIME_EXPIRED',
    );
    expect(ledger.post).not.toHaveBeenCalled();
  });
});
