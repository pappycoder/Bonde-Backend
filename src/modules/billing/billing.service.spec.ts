import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AiCreditsService } from './ai-credits.service.js';
import { BillingService } from './billing.service.js';
import { WELCOME_CREDITS } from './billing.catalog.js';

/** A transactional in-memory ledger: failures roll back all balances, grants and orders. */
function setup(balance = '20000.00') {
  let state = {
    wallet: { id: 'wallet', currency: 'NGN', balance: new Prisma.Decimal('999999.00') },
    ledgerBalance: new Prisma.Decimal(balance),
    profile: {
      id: 'owner',
      email: 'owner@example.com',
      cardPlan: 'FREE',
      cardPlanExpiresAt: null as Date | null,
      billingCancelAtPeriodEnd: false,
    },
    credits: {
      ledgerInitialized: false,
      userId: 'owner',
      welcomeRemaining: WELCOME_CREDITS,
      planRemaining: 0,
      planGranted: 0,
      planUsed: 0,
      purchasedRemaining: 0,
      periodEnd: null as Date | null,
    },
    grants: [] as Array<Record<string, any>>,
    entries: [] as Array<Record<string, any>>,
    orders: [] as Array<Record<string, any>>,
    transactions: [] as Array<Record<string, any>>,
  };
  let tail = Promise.resolve();
  const db = {
    $queryRaw: vi.fn(async () => []),
    profile: {
      findUnique: vi.fn(async () => state.profile),
      findUniqueOrThrow: vi.fn(async () => state.profile),
      findMany: vi.fn(async () =>
        state.profile.cardPlanExpiresAt &&
        state.profile.cardPlanExpiresAt <= new Date() &&
        !state.profile.billingCancelAtPeriodEnd
          ? [state.profile]
          : [],
      ),
      update: vi.fn(async ({ data }) => Object.assign(state.profile, data)),
      updateMany: vi.fn(async ({ where, data }) => {
        if (
          state.profile.cardPlanExpiresAt?.getTime() !== where.cardPlanExpiresAt?.getTime() ||
          state.profile.billingCancelAtPeriodEnd !== where.billingCancelAtPeriodEnd
        )
          return { count: 0 };
        Object.assign(state.profile, data);
        return { count: 1 };
      }),
    },
    aiCreditAccount: {
      upsert: vi.fn(async () => state.credits),
      update: vi.fn(async ({ data }) => {
        for (const [key, value] of Object.entries(data)) {
          (state.credits as any)[key] =
            value && typeof value === 'object' && 'increment' in value
              ? (state.credits as any)[key] + value.increment
              : value;
        }
        return state.credits;
      }),
    },
    aiCreditGrant: {
      findUnique: vi.fn(
        async ({ where }) => state.grants.find((g) => g.sourceKey === where.sourceKey) ?? null,
      ),
      findMany: vi.fn(async ({ where }) =>
        state.grants.filter(
          (g) =>
            g.userId === where.userId &&
            (!where.expiresAt || (g.expiresAt && g.expiresAt <= where.expiresAt.lte)) &&
            (!where.remaining || g.remaining > where.remaining.gt),
        ),
      ),
      create: vi.fn(async ({ data }) => {
        const grant = { reserved: 0, createdAt: new Date(), ...data };
        state.grants.push(grant);
        return grant;
      }),
      update: vi.fn(async ({ where, data }) =>
        Object.assign(
          state.grants.find((g) => g.id === where.id)!,
          data,
        ),
      ),
    },
    aiCreditEntry: {
      create: vi.fn(async ({ data }) => {
        state.entries.push(data);
        return data;
      }),
    },
    billingOrder: {
      findFirst: vi.fn(
        async ({ where }) =>
          state.orders.find(
            (o) =>
              o.userId === where.userId &&
              (!where.id || o.id === where.id) &&
              (!where.kind || o.kind === where.kind) &&
              (!where.status || o.status === where.status),
          ) ?? null,
      ),
      findUnique: vi.fn(
        async ({ where }) =>
          state.orders.find(
            (o) =>
              o.userId === where.userId_idempotencyKey.userId &&
              o.idempotencyKey === where.userId_idempotencyKey.idempotencyKey,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }) => {
        const order = {
          status: 'PENDING',
          currency: 'NGN',
          transactionId: null,
          failureReason: null,
          createdAt: new Date(),
          ...data,
          amount: new Prisma.Decimal(data.amount),
        };
        state.orders.push(order);
        return order;
      }),
      update: vi.fn(async ({ where, data }) =>
        Object.assign(
          state.orders.find((o) => o.id === where.id)!,
          data,
        ),
      ),
      upsert: vi.fn(
        async ({ where, create }) =>
          (await db.billingOrder.findUnique({ where })) ?? db.billingOrder.create({ data: create }),
      ),
    },
    card: { findFirst: vi.fn(async () => null) },
    wallet: {
      findFirst: vi.fn(async () => state.wallet),
    },
    financeAccount: { findUnique: vi.fn(async () => ({ balance: state.ledgerBalance })) },
    notification: { create: vi.fn(async () => undefined) },
    auditLog: { create: vi.fn(async () => undefined) },
    transaction: {
      create: vi.fn(async ({ data }) => {
        state.transactions.push(data);
        return data;
      }),
    },
    $transaction: async (fn: (db: any) => Promise<any>) => {
      const prior = tail;
      let release!: () => void;
      tail = new Promise<void>((r) => {
        release = r;
      });
      await prior;
      const snapshot = {
        ...state,
        wallet: { ...state.wallet },
        profile: { ...state.profile },
        credits: { ...state.credits },
        grants: state.grants.map((g) => ({ ...g })),
        entries: state.entries.map((e) => ({ ...e })),
        orders: state.orders.map((o) => ({ ...o })),
        transactions: [...state.transactions],
      };
      try {
        return await fn(db);
      } catch (error) {
        state = snapshot;
        throw error;
      } finally {
        release();
      }
    },
  };
  const passcode = { validate: vi.fn(async () => undefined) };
  const config = { get: vi.fn(() => ({ billingEnabled: true })) };
  const ledger = {
    post: vi.fn(async (_tx, _reference, _description, lines) => {
      expect(
        lines.reduce((sum, line) => sum.add(line.amount), new Prisma.Decimal(0)).isZero(),
      ).toBe(true);
      const debit = lines.find((line) => line.userId === 'owner');
      expect(debit.key).toBe('wallet:owner:NGN');
      state.ledgerBalance = state.ledgerBalance.add(debit.amount);
    }),
  };
  const capabilities = {
    assertCurrency: vi.fn(),
    view: () => ({ currencies: { NGN: { enabled: true } } }),
  };
  const service = new BillingService(
    db as never,
    passcode as never,
    config as never,
    ledger as never,
    capabilities as never,
    new AiCreditsService(),
  );
  const create = (
    productId = 'pack-50',
    idempotencyKey = 'purchase-one',
    recurringConsent = false,
  ) =>
    service.create('owner', {
      productId,
      idempotencyKey,
      paymentMethod: 'WALLET',
      recurringConsent,
    });
  return { service, db, passcode, config, create, state: () => state };
}

describe('Billing ledger', () => {
  it('advertises the smaller welcome and Premium allowances without changing prices or top-up packs', async () => {
    const f = setup();
    expect(f.service.catalog()).toMatchObject({
      free: { welcomeCredits: 10 },
      premium: { credits: 100, amount: '6000.00' },
    });
    expect(f.service.catalog().packs.map((p) => p.credits)).toEqual([10, 50, 60, 70]);
    expect(await f.service.summary('owner')).toMatchObject({
      welcomeAllowance: 10,
      renewalRequiresReview: false,
      credits: { welcome: 10, total: 10 },
    });
    expect(f.db.aiCreditAccount.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { userId: 'owner', welcomeRemaining: 10 } }),
    );
  });
  it('refuses stale unpaid offers and their retries without charging or repricing them', async () => {
    const f = setup();
    const order = await f.create('premium-monthly', 'old-pending', true);
    f.state().orders[0].credits = 8000;
    await expect(f.service.confirm('owner', order.id, '1234')).rejects.toThrow('offer has changed');
    await expect(f.create('premium-monthly', 'old-pending', true)).rejects.toThrow(
      'offer has changed',
    );
    expect(f.state().ledgerBalance.toFixed(2)).toBe('20000.00');
    expect(f.state().orders[0].credits).toBe(8000);
    expect(f.state().transactions).toHaveLength(0);
    expect((await f.create('premium-monthly', 'new-offer', true)).credits).toBe(100);
  });
  it('preserves a successful old receipt and its issued current-period credits', async () => {
    const f = setup();
    const order = await f.create('premium-monthly', 'old-paid', true);
    await f.service.confirm('owner', order.id, '1234');
    f.state().orders[0].credits = 8000;
    f.state().credits.planRemaining = 8000;
    f.state().credits.planGranted = 8000;
    for (const grant of f.state().grants.filter((g) => g.source === 'PLAN'))
      Object.assign(grant, { units: 8000, remaining: 8000 });
    const balance = f.state().ledgerBalance.toFixed(2);
    expect(await f.service.summary('owner')).toMatchObject({
      renewalRequiresReview: true,
      credits: { plan: 8000 },
    });
    expect((await f.service.confirm('owner', order.id, '1234')).credits).toBe(8000);
    expect(f.state().ledgerBalance.toFixed(2)).toBe(balance);
  });
  it('pauses old recurring terms once and requires a new subscription without charging or granting a smaller period', async () => {
    const f = setup();
    const order = await f.create('premium-monthly', 'old-paid', true);
    await f.service.confirm('owner', order.id, '1234');
    f.state().orders[0].credits = 8000;
    f.state().profile.cardPlanExpiresAt = new Date('2000-01-01');
    await Promise.all([f.service.renewDue(), f.service.renewDue()]);
    expect(f.state().profile.billingCancelAtPeriodEnd).toBe(true);
    expect(f.state().transactions).toHaveLength(1);
    expect(f.state().ledgerBalance.toFixed(2)).toBe('14000.00');
    expect(f.db.notification.create).toHaveBeenCalledOnce();
    expect(f.state().orders).toHaveLength(1);
  });
  it('uses server prices and confirms concurrent duplicate requests exactly once', async () => {
    const f = setup();
    const order = await f.create();
    const [a, b] = await Promise.all([
      f.service.confirm('owner', order.id, '1234'),
      f.service.confirm('owner', order.id, '1234'),
    ]);
    expect(a.transactionId).toBe(b.transactionId);
    expect(f.state().ledgerBalance.toFixed(2)).toBe('14000.00');
    expect(f.state().credits.purchasedRemaining).toBe(50);
    expect(f.state().transactions).toHaveLength(1);
    expect(f.state().transactions[0].metadata.creditsPurchased).toBe('50');
  });
  it('declines insufficient funds without granting entitlements', async () => {
    const f = setup('5999.99');
    const order = await f.create();
    const failed = await f.service.confirm('owner', order.id, '1234');
    expect(failed.status).toBe('FAIL');
    expect(f.state().ledgerBalance.toFixed(2)).toBe('5999.99');
    expect(f.state().credits.purchasedRemaining).toBe(0);
    expect(f.state().transactions).toHaveLength(0);
    const retry = await f.create();
    expect(retry.id).toBe(order.id);
    expect(f.state().orders).toHaveLength(1);
  });
  it('rolls back a debit and credits if recording the transaction fails', async () => {
    const f = setup();
    const order = await f.create();
    f.db.transaction.create.mockRejectedValueOnce(new Error('database failure'));
    await expect(f.service.confirm('owner', order.id, '1234')).rejects.toThrow('database failure');
    expect(f.state().ledgerBalance.toFixed(2)).toBe('20000.00');
    expect(f.state().credits.purchasedRemaining).toBe(0);
    expect(f.state().orders[0].status).toBe('PENDING');
  });
  it('requires recurring consent, grants 100 credits and retains paid benefits after cancellation', async () => {
    const f = setup();
    await expect(f.create('premium-monthly')).rejects.toThrow('terms');
    const order = await f.create('premium-monthly', 'premium', true);
    await f.service.confirm('owner', order.id, '1234');
    expect(f.state().credits.planRemaining).toBe(100);
    expect(f.state().profile.cardPlan).toBe('PREMIUM');
    const summary = await f.service.cancel('owner');
    expect(summary).toMatchObject({
      plan: 'PREMIUM',
      cancelAtPeriodEnd: true,
      activeCardLimit: 15,
    });
  });
  it('does not reduce a legacy welcome allowance or count expired credits as usage', async () => {
    const f = setup();
    f.state().credits.welcomeRemaining = 100;
    f.state().credits.planGranted = 8000;
    f.state().credits.planRemaining = 8000;
    f.state().credits.periodEnd = new Date('2000-01-01');
    expect((await f.service.summary('owner')).credits).toMatchObject({
      welcome: 100,
      plan: 0,
      used: 0,
      total: 100,
    });
    expect((await f.service.summary('owner')).credits.welcome).toBe(100);
  });
  it('rejects another owner, wrong PIN, or disabled payment processing before debiting', async () => {
    const f = setup();
    const order = await f.create();
    await expect(f.service.confirm('other', order.id, '1234')).rejects.toThrow('not found');
    f.passcode.validate.mockRejectedValueOnce(new Error('wrong passcode'));
    await expect(f.service.confirm('owner', order.id, '0000')).rejects.toThrow('wrong passcode');
    f.config.get.mockReturnValueOnce({ billingEnabled: false });
    await expect(f.service.confirm('owner', order.id, '1234')).rejects.toThrow('unavailable');
    expect(f.state().ledgerBalance.toFixed(2)).toBe('20000.00');
  });
  it('renews an expired consented wallet subscription once across competing workers', async () => {
    const f = setup();
    const order = await f.create('premium-monthly', 'premium', true);
    await f.service.confirm('owner', order.id, '1234');
    f.state().profile.cardPlanExpiresAt = new Date('2000-01-01');
    f.state().credits.periodEnd = new Date('2000-01-01');
    for (const grant of f.state().grants.filter((g) => g.source === 'PLAN'))
      grant.expiresAt = new Date('2000-01-01');
    await Promise.all([f.service.renewDue(), f.service.renewDue()]);
    expect(f.state().ledgerBalance.toFixed(2)).toBe('8000.00');
    expect(f.state().transactions).toHaveLength(2);
    expect(f.state().credits.planRemaining).toBe(100);
  });
  it('does not autocharge legacy Premium or a cancelled subscription', async () => {
    const f = setup();
    f.state().profile.cardPlan = 'PREMIUM';
    f.state().profile.cardPlanExpiresAt = new Date('2000-01-01');
    await f.service.renewDue();
    expect(f.state().transactions).toHaveLength(0);
    f.state().profile.cardPlan = 'FREE';
    const order = await f.create('premium-monthly', 'premium', true);
    await f.service.confirm('owner', order.id, '1234');
    await f.service.cancel('owner');
    f.state().profile.cardPlanExpiresAt = new Date('2000-01-01');
    await f.service.renewDue();
    expect(f.state().transactions).toHaveLength(1);
  });
  it('cancels an abandoned order and rejects a cancelled order confirmation', async () => {
    const f = setup();
    const order = await f.create();
    expect((await f.service.cancelOrder('owner', order.id)).status).toBe('CANCELLED');
    await expect(f.service.confirm('owner', order.id, '1234')).rejects.toThrow('Retry');
    expect(f.state().transactions).toHaveLength(0);
  });
});
