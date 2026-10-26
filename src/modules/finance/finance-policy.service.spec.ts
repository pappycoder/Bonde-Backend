import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { FinancePolicy } from './finance-policy.service.js';
const d = (n: string) => new Prisma.Decimal(n);
function setup() {
  const tx = {
    financeCapture: {
      findMany: vi.fn(async () => [{ authorizationId: 'partial' }]),
      aggregate: vi.fn(async () => ({ _sum: { amount: d('30') } })),
    },
    financeAuthorization: {
      findMany: vi.fn(async () => [
        {
          id: 'partial',
          requestType: 'PURCHASE',
          amount: d('100'),
          settled: d('30'),
          released: d('10'),
        },
        {
          id: 'older-month',
          requestType: 'PURCHASE',
          amount: d('20'),
          settled: d('0'),
          released: d('5'),
        },
        {
          id: 'fee-only',
          requestType: 'VERIFICATION',
          amount: d('1'),
          settled: d('0'),
          released: d('0'),
        },
      ]),
    },
  };
  const card = {
    id: 'card',
    currency: 'NGN',
    expirationDate: new Date('2099-01-01'),
    retirementReason: null,
    creationLockType: 'SELF_DESTRUCT',
    locks: [{ lockType: 'SELF_DESTRUCT', config: { type: 'SELF_DESTRUCT', usageLimit: 2 } }],
  };
  return { tx, card, policy: new FinancePolicy() };
}
describe('shared card policy snapshots', () => {
  it('counts partial captures once and reserves only remaining principal, including older holds and genuine verification fees', async () => {
    const { tx, card, policy } = setup();
    const state = await policy.snapshot(
      tx as never,
      card as never,
      new Date('2026-11-01T00:00:00Z'),
    );
    expect(state.spent.toFixed(2)).toBe('106.00');
    expect(state.held.toFixed(2)).toBe('76.00');
    expect(state.completedUses).toBe(1);
    expect(state.uses).toBe(2);
    expect(state.reason).toBeNull(); // all slots reserved is not permanent completion
    expect(tx.financeCapture.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ bookedAt: { gte: new Date('2026-11-01T00:00:00Z') } }),
      }),
    );
    expect(tx.financeAuthorization.findMany).toHaveBeenCalledWith({
      where: { cardId: 'card', status: 'HELD' },
    });
  });
  it('retires only after the completed usage ceiling is reached, regardless of refund accounting', async () => {
    const { tx, card, policy } = setup();
    tx.financeCapture.findMany.mockResolvedValue([
      { authorizationId: 'a' },
      { authorizationId: 'b' },
    ]);
    const state = await policy.snapshot(tx as never, card as never);
    expect(state.reason).toBe('USAGE_LIMIT');
  });
  it('honours the earliest time deadline and preserves an existing permanent reason', async () => {
    const { tx, card, policy } = setup();
    const timed = {
      ...card,
      creationLockType: 'TIME',
      locks: [
        {
          lockType: 'TIME',
          config: { type: 'TIME', start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' },
        },
      ],
    };
    expect(
      (await policy.snapshot(tx as never, timed as never, new Date('2026-10-02T00:00:00Z'))).reason,
    ).toBe('TIME_EXPIRED');
    expect(
      (await policy.snapshot(tx as never, { ...card, retirementReason: 'USER_REQUESTED' } as never))
        .reason,
    ).toBe('USER_REQUESTED');
  });
  it.each(['missing', 'conflicting', 'malformed'])(
    'fails closed for %s legacy controls instead of treating them as a standard card',
    async (kind) => {
      const { tx, card, policy } = setup();
      const locks =
        kind === 'missing'
          ? []
          : kind === 'conflicting'
            ? [...card.locks, ...card.locks]
            : [{ lockType: 'SELF_DESTRUCT', config: { type: 'SELF_DESTRUCT', usageLimit: 0 } }];
      expect((await policy.snapshot(tx as never, { ...card, locks } as never)).controlsValid).toBe(
        false,
      );
    },
  );
  it('rejects corrupt negative reservations instead of increasing purchasing power', async () => {
    const { tx, card, policy } = setup();
    tx.financeAuthorization.findMany.mockResolvedValue([
      { id: 'bad', requestType: 'PURCHASE', amount: d('1'), settled: d('2'), released: d('0') },
    ]);
    await expect(policy.snapshot(tx as never, card as never)).rejects.toThrow(
      'Invalid authorization',
    );
  });
});
