import { describe, expect, it, vi } from 'vitest';
import { FinanceMerchants } from './finance-merchants.service.js';
const identity = '11111111-1111-4111-8111-111111111111';
const catalog = '22222222-2222-4222-8222-222222222222';
function setup() {
  const tx = {
    financeMerchantIdentity: {
      findFirst: vi.fn(async () => ({ id: identity })),
      count: vi.fn(async () => 1),
    },
    financeMerchantCatalog: { findFirst: vi.fn(async () => ({ identityIds: [identity] })) },
    financeMerchantCandidate: { findFirst: vi.fn(async () => null) },
    cardLock: { update: vi.fn(), findFirst: vi.fn(async () => null) },
    $queryRaw: vi.fn(),
  };
  return {
    tx,
    service: new FinanceMerchants(
      {} as never,
      { get: () => ({ environment: 'sandbox' }) } as never,
      {} as never,
    ),
  };
}
describe('verified merchant selections', () => {
  it('rejects raw MIDs and never resolves a brand display name', async () => {
    const { service, tx } = setup();
    await expect(
      service.resolveRules(tx as never, 'owner', { type: 'MERCHANT', merchantIds: ['Netflix'] }),
    ).rejects.toThrow('raw merchant IDs');
    await expect(
      service.resolveRules(tx as never, 'owner', {
        type: 'MERCHANT',
        merchantSelections: ['Netflix'],
      }),
    ).rejects.toThrow('Invalid merchant choice');
  });
  it('uses exact owner/environment identities and published catalog version snapshots', async () => {
    const { service, tx } = setup();
    expect(
      await service.resolveRules(tx as never, 'owner', {
        type: 'MERCHANT',
        merchantSelections: [`identity:${identity}`, `catalog:${catalog}:3`],
      }),
    ).toEqual({ type: 'MERCHANT', merchantIds: [identity] });
    expect(tx.financeMerchantIdentity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: identity,
          environment: 'sandbox',
          revokedAt: null,
          access: { some: { userId: 'owner' } },
        }),
      }),
    );
    expect(tx.financeMerchantCatalog.findFirst).toHaveBeenCalledWith({
      where: { id: catalog, version: 3, status: 'PUBLISHED' },
    });
  });
  it('fails closed on changed catalog evidence, foreign choices and expired candidate bindings', async () => {
    const { service, tx } = setup();
    tx.financeMerchantCatalog.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      service.resolveRules(tx as never, 'owner', {
        type: 'MERCHANT',
        merchantSelections: [`catalog:${catalog}:3`],
      }),
    ).rejects.toThrow('changed');
    tx.financeMerchantIdentity.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      service.resolveRules(tx as never, 'owner', {
        type: 'MERCHANT',
        merchantSelections: [`identity:${identity}`],
      }),
    ).rejects.toThrow('unavailable');
    await expect(
      service.bind(
        tx as never,
        { id: 'card', userId: 'owner', rulesVersion: 2, creationLockType: 'MERCHANT' } as never,
        'enrollment',
        'candidate',
        2,
      ),
    ).rejects.toThrow('expired');
    expect(tx.cardLock.update).not.toHaveBeenCalled();
  });
  it('permits a named enrollment intent without granting any merchant identity', async () => {
    const { service, tx } = setup();
    expect(
      await service.resolveRules(tx as never, 'owner', {
        type: 'MERCHANT',
        pendingMerchantLabel: 'New store',
      }),
    ).toEqual({ type: 'MERCHANT', pendingMerchantLabel: 'New store', merchantIds: [] });
  });
});
