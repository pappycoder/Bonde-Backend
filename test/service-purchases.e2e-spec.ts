import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ServicePurchases } from '../src/modules/finance/service-purchases.service.js';
import { SafeHavenVasClient } from '../src/modules/finance/safe-haven-vas.client.js';
import { LedgerService } from '../src/modules/finance/ledger.service.js';
import { PasscodeService } from '../src/modules/passcode/passcode.service.js';
import { walletKey } from '../src/modules/finance/finance.types.js';
import {
  bootE2EApp,
  SEED_USER_ID,
  SEED_OTHER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

describe('Authorized service purchases (e2e)', () => {
  let ctx: BootedE2EApp;
  let service: ServicePurchases;
  let amount = '1000.00';
  let name = 'Verified customer';
  let pending = false;
  let unresolved = false;
  const plans = vi.fn(async () => [
    {
      serviceId: 'gotv',
      code: 'test-plan',
      name: 'Test plan',
      amount,
      currency: 'NGN',
      providerCategoryId: 'gotv-category',
      providerPlanCode: 'test-plan',
    },
  ]);
  const purchase = vi.fn(async () => {
    if (pending) throw new Error('provider connection lost after submission');
  });
  const requery = vi.fn(async (reference: string) => ({
    status: unresolved ? ('PENDING' as const) : ('SUCCEEDED' as const),
    reference,
    amount: '1000.00',
    beneficiary: '1212121212',
    categoryId: 'gotv-category',
    transactionId: 'provider-receipt',
  }));
  const provider = {
    name: 'SAFE_HAVEN',
    assertEnabled: vi.fn(),
    assertPurchasesEnabled: vi.fn(),
    environment: 'sandbox',
    balance: vi.fn(async () => new Prisma.Decimal('100000.00')),
    plans,
    verify: vi.fn(async () => ({ name, verified: true })),
    purchase,
    requery,
  };
  beforeAll(async () => {
    ctx = await bootE2EApp({ overrides: [{ token: SafeHavenVasClient, useValue: provider }] });
    service = ctx.app.get(ServicePurchases);
    service.onModuleDestroy();
    const config = ctx.app.get(ConfigService);
    config.set('shopping', {
      ...config.get('shopping'),
      servicesEnabled: true,
      serviceFee: '0.00',
    });
    vi.spyOn(ctx.app.get(PasscodeService), 'validate').mockResolvedValue({ valid: true });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
    amount = '1000.00';
    name = 'Verified customer';
    pending = false;
    unresolved = false;
    purchase.mockClear();
    requery.mockClear();
    await ctx.prisma.$transaction((tx) =>
      ctx.app.get(LedgerService).post(tx, `test:${randomUUID()}`, 'Verified test funding', [
        {
          key: 'system:test:NGN',
          currency: 'NGN',
          kind: 'TEST',
          amount: new Prisma.Decimal('-10000.00'),
        },
        {
          key: walletKey(SEED_USER_ID, 'NGN'),
          userId: SEED_USER_ID,
          currency: 'NGN',
          kind: 'WALLET',
          amount: new Prisma.Decimal('10000.00'),
        },
      ]),
    );
  });
  async function quote() {
    return service.quote(SEED_USER_ID, {
      serviceId: 'gotv',
      variationCode: 'test-plan',
      beneficiary: '1212121212',
      phone: '08012345678',
    });
  }
  async function buy() {
    const q = await quote();
    const proof = await service.proof(SEED_USER_ID, q.id, '1234');
    return {
      quote: q,
      proof,
      order: await service.execute(SEED_USER_ID, q.id, proof.proof, randomUUID()),
    };
  }
  async function available() {
    return (
      await ctx.prisma.financeAccount.findUniqueOrThrow({
        where: { key: walletKey(SEED_USER_ID, 'NGN') },
      })
    ).balance.toFixed(2);
  }
  it('reserves funds once, confirms delivery and produces one receipt with duplicate processing', async () => {
    const { order, quote: q, proof } = await buy();
    expect(await available()).toBe('9000.00');
    expect((await service.execute(SEED_USER_ID, q.id, proof.proof, randomUUID())).id).toBe(
      order.id,
    );
    await service.run();
    await service.run();
    expect((await service.order(SEED_USER_ID, order.id)).status).toBe('SUCCEEDED');
    expect(purchase).toHaveBeenCalledTimes(1);
    expect(
      await ctx.prisma.financeJournal.count({ where: { reference: `service-settle:${order.id}` } }),
    ).toBe(1);
    expect(await available()).toBe('9000.00');
    expect(await ctx.prisma.transaction.count({ where: { id: order.id, status: 'SUCCESS' } })).toBe(
      1,
    );
  });
  it('never resubmits a timed-out provider purchase and reconciles its original reference', async () => {
    pending = true;
    const { order } = await buy();
    await service.run();
    expect((await service.order(SEED_USER_ID, order.id)).status).toBe('SUCCEEDED');
    expect(purchase).toHaveBeenCalledTimes(1);
    expect(requery).toHaveBeenCalledTimes(1);
    expect(await available()).toBe('9000.00');
  });
  it('retains unknown holds through repeated reconciliation without resubmitting', async () => {
    pending = true;
    unresolved = true;
    const { order } = await buy();
    await service.run();
    await service.run();
    expect((await service.order(SEED_USER_ID, order.id)).status).toBe('PENDING');
    expect(await available()).toBe('9000.00');
    expect(purchase).toHaveBeenCalledTimes(1);
    unresolved = false;
    await service.requeryReference(
      (await ctx.prisma.serviceOrder.findUniqueOrThrow({ where: { id: order.id } }))
        .providerReference,
    );
    await service.run();
    expect((await service.order(SEED_USER_ID, order.id)).status).toBe('SUCCEEDED');
    expect(
      await ctx.prisma.financeJournal.count({ where: { reference: `service-settle:${order.id}` } }),
    ).toBe(1);
    await expect(service.order(SEED_OTHER_ID, order.id)).rejects.toMatchObject({ status: 404 });
  });
  it('returns held funds only after a definitive provider failure', async () => {
    const { order } = await buy();
    requery.mockResolvedValueOnce({
      status: 'FAILED',
      reference: (await ctx.prisma.serviceOrder.findUniqueOrThrow({ where: { id: order.id } }))
        .providerReference,
      amount: '1000.00',
      beneficiary: '1212121212',
      categoryId: 'gotv-category',
      transactionId: 'provider-receipt',
    } as never);
    await service.run();
    expect((await service.order(SEED_USER_ID, order.id)).status).toBe('FAILED');
    expect(await available()).toBe('10000.00');
  });
  it('preserves old provider receipts and refuses to execute old quotes with Safe Haven', async () => {
    const { order, quote: q } = await buy();
    await ctx.prisma.serviceOrder.update({
      where: { id: order.id },
      data: { provider: 'VTPASS', status: 'SUCCEEDED' },
    });
    await ctx.prisma.serviceQuote.update({
      where: { id: q.id },
      data: { provider: 'VTPASS', providerCategoryId: null, providerPlanCode: null },
    });
    await service.run();
    expect(purchase).not.toHaveBeenCalled();
    expect(requery).not.toHaveBeenCalled();
    expect((await service.order(SEED_USER_ID, order.id)).quote.id).toBe(q.id);
    await expect(service.proof(SEED_USER_ID, q.id, '1234')).rejects.toThrow('provider changed');
  });
  it('keeps mismatched settlement evidence pending without releasing or charging again', async () => {
    const { order } = await buy();
    unresolved = true;
    requery.mockResolvedValueOnce({
      status: 'SUCCEEDED',
      reference: 'wrong-reference',
      amount: '1000.00',
      beneficiary: '1212121212',
      categoryId: 'gotv-category',
      transactionId: 'wrong-receipt',
    } as never);
    await service.run();
    expect((await service.order(SEED_USER_ID, order.id)).status).toBe('PENDING');
    expect(await available()).toBe('9000.00');
    await service.run();
    expect(purchase).toHaveBeenCalledTimes(1);
  });
  it('rejects approval when the native plan identity changes', async () => {
    const q = await quote();
    const proof = await service.proof(SEED_USER_ID, q.id, '1234');
    plans.mockResolvedValueOnce([
      {
        serviceId: 'gotv',
        code: 'test-plan',
        name: 'Test plan',
        amount,
        currency: 'NGN',
        providerCategoryId: 'new-category',
        providerPlanCode: 'test-plan',
      },
    ]);
    await expect(service.execute(SEED_USER_ID, q.id, proof.proof, randomUUID())).rejects.toThrow(
      'price has changed',
    );
    expect(await available()).toBe('10000.00');
  });
  it('blocks the cutover migration while any old supplier outcome is unresolved', async () => {
    const { order } = await buy();
    await ctx.prisma.serviceOrder.update({
      where: { id: order.id },
      data: { provider: 'VTPASS', status: 'PENDING' },
    });
    const migration = readFileSync(
      'prisma/migrations/20261106000000_safe_haven_services/migration.sql',
      'utf8',
    );
    const guard = migration.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/)![0];
    await expect(ctx.prisma.$executeRawUnsafe(guard)).rejects.toThrow('Reconcile all VTpass');
    expect(await available()).toBe('9000.00');
    await ctx.prisma.serviceOrder.update({ where: { id: order.id }, data: { status: 'FAILED' } });
    await expect(ctx.prisma.$executeRawUnsafe(guard)).resolves.toBeDefined();
  });
  it('releases an expired queued quote without submitting it to the supplier', async () => {
    const { order, quote: q } = await buy();
    await ctx.prisma.serviceQuote.update({ where: { id: q.id }, data: { expiresAt: new Date(0) } });
    await service.run();
    expect((await service.order(SEED_USER_ID, order.id)).status).toBe('FAILED');
    expect(purchase).not.toHaveBeenCalled();
    expect(await available()).toBe('10000.00');
  });
  it('invalidates changed price/beneficiary approvals and rejects quote access by another user', async () => {
    const q = await quote();
    const proof = await service.proof(SEED_USER_ID, q.id, '1234');
    amount = '1100.00';
    await expect(service.execute(SEED_USER_ID, q.id, proof.proof, randomUUID())).rejects.toThrow(
      'price has changed',
    );
    amount = '1000.00';
    name = 'Another beneficiary';
    await expect(service.execute(SEED_USER_ID, q.id, proof.proof, randomUUID())).rejects.toThrow(
      'Beneficiary details changed',
    );
    await expect(service.proof(SEED_OTHER_ID, q.id, '1234')).rejects.toMatchObject({ status: 404 });
    expect(await available()).toBe('10000.00');
  });
  it('renewal reminders do not charge wallets or execute a purchase', async () => {
    const { order } = await buy();
    await service.run();
    const reminder = await service.reminder(SEED_USER_ID, order.id, new Date(Date.now() + 60_000));
    await ctx.prisma.serviceReminder.update({
      where: { id: reminder.id },
      data: { dueAt: new Date(0) },
    });
    purchase.mockClear();
    requery.mockClear();
    await service.run();
    await service.run();
    expect(purchase).not.toHaveBeenCalled();
    expect(requery).not.toHaveBeenCalled();
    expect(await available()).toBe('9000.00');
    expect(
      await ctx.prisma.notification.count({ where: { title: 'Subscription renewal reminder' } }),
    ).toBe(1);
    expect((await service.renewalQuote(SEED_USER_ID, order.id)).id).not.toBe(order.quote.id);
  });
});
