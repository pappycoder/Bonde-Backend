import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { CardAccessService } from './card-access.service.js';

function setup({
  premium = false,
  expired = false,
  cards = [] as Array<{ creationLockType: string | null; locks: unknown[] }>,
} = {}) {
  const db = {
    profile: {
      findUnique: vi.fn(async () => ({
        cardPlan: premium ? 'PREMIUM' : 'FREE',
        cardPlanExpiresAt: expired ? new Date('2020-01-01') : null,
      })),
    },
    card: {
      findMany: vi.fn(async () => cards),
      findFirst: vi.fn(async () => ({
        status: 'ACTIVE',
        expirationDate: new Date('2099-01-01'),
        monthlyLimit: null,
        locks: [],
      })),
    },
    transaction: {
      count: vi.fn(async () => 0),
      aggregate: vi.fn(async () => ({ _sum: { amount: new Prisma.Decimal(0) } })),
    },
  };
  return { db, service: new CardAccessService(db as never) };
}
const standard = { creationLockType: null, locks: [] };
const rules = { creationLockType: 'SELF_DESTRUCT', locks: [] };
describe('CardAccessService', () => {
  it('separates Free Standard and rule-based capacity from owned live counts', async () => {
    const { db, service } = setup({ cards: [standard, rules, rules] });
    expect(await service.summary('owner')).toMatchObject({
      plan: 'FREE',
      standard: { active: 1, limit: 1 },
      ruleBased: { active: 2, limit: 2 },
      canCreateStandard: false,
      canCreateRuleBased: false,
      retained: false,
    });
    await expect(service.assertCreation('owner')).rejects.toThrow('active-card limit');
    expect(db.card.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'owner', status: { in: ['ACTIVE', 'PAUSED'] } }),
      }),
    );
  });
  it('counts existing locks and a reserved rule slot before lock setup completes', async () => {
    const { service } = setup({
      cards: [{ creationLockType: null, locks: [{ id: 'lock' }] }, rules],
    });
    expect(await service.summary('owner')).toMatchObject({
      standard: { active: 0 },
      ruleBased: { active: 2 },
      canCreateStandard: true,
      canCreateRuleBased: false,
    });
  });
  it('retains excess cards after Premium expiry without mutating any card', async () => {
    const { service } = setup({
      premium: true,
      expired: true,
      cards: [standard, ...Array(6).fill(rules)],
    });
    expect(await service.summary('owner')).toMatchObject({
      subscriptionExpired: true,
      retained: true,
      ruleBased: { active: 6 },
      canCreateStandard: false,
      canCreateRuleBased: false,
    });
  });
  it('an active Premium entitlement allows new cards', async () => {
    const { service } = setup({ premium: true, cards: [standard, rules, rules] });
    expect(await service.summary('owner')).toMatchObject({
      plan: 'PREMIUM',
      canCreateStandard: true,
      canCreateRuleBased: true,
    });
  });
  it('caps Premium at 15 active cards', async () => {
    const { service } = setup({ premium: true, cards: Array(15).fill(standard) });
    expect(await service.summary('owner')).toMatchObject({
      canCreateStandard: false,
      canCreateRuleBased: false,
    });
  });
  it('requires an owned card before reporting its availability', async () => {
    const { service, db } = setup();
    db.card.findFirst.mockResolvedValueOnce(null as never);
    await expect(service.cardStatus('owner', 'other-card')).rejects.toThrow('Card not found');
  });
  it('reports expiry without counting transactions', async () => {
    const { service, db } = setup();
    db.card.findFirst.mockResolvedValueOnce({
      status: 'ACTIVE',
      expirationDate: new Date('2020-01-01'),
      locks: [],
    } as never);
    expect(await service.cardStatus('owner', 'card')).toEqual({ reason: 'EXPIRED' });
    expect(db.transaction.count).not.toHaveBeenCalled();
  });
  it('checks usage against settled approved payments only', async () => {
    const { service, db } = setup();
    db.card.findFirst.mockResolvedValueOnce({
      status: 'ACTIVE',
      expirationDate: new Date('2099-01-01'),
      locks: [{ lockType: 'SELF_DESTRUCT', config: { usageLimit: 2 } }],
    } as never);
    db.transaction.count.mockResolvedValueOnce(2);
    expect(await service.cardStatus('owner', 'card')).toMatchObject({
      reason: 'USAGE_LIMIT',
      used: 2,
      limit: 2,
    });
    expect(db.transaction.count).toHaveBeenCalledWith({
      where: {
        cardId: 'card',
        userId: 'owner',
        type: 'PAYMENT',
        status: 'SUCCESS',
        approvalStatus: 'APPROVED',
      },
    });
  });
  it('monthly budgets use the current UTC period, not lifetime spend', async () => {
    const { service, db } = setup();
    db.card.findFirst.mockResolvedValueOnce({
      status: 'ACTIVE',
      expirationDate: new Date('2099-01-01'),
      monthlyLimit: new Prisma.Decimal(10),
      locks: [],
      totalSpent: new Prisma.Decimal(999),
    } as never);
    db.transaction.aggregate.mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal(10) } });
    expect(await service.cardStatus('owner', 'card')).toMatchObject({
      reason: 'BUDGET_LIMIT',
      spent: '10.00',
    });
    expect(db.transaction.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: expect.any(Date), lt: expect.any(Date) },
        }),
      }),
    );
  });
});
