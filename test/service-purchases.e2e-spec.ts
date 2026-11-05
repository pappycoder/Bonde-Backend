import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ServicePurchases } from '../src/modules/finance/service-purchases.service.js';
import { VtpassClient } from '../src/modules/finance/vtpass.client.js';
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
    { serviceId: 'gotv', code: 'test-plan', name: 'Test plan', amount, currency: 'NGN' },
  ]);
  const call = vi.fn(async (path: string, body: Record<string, unknown>) => {
    if (pending && path === '/pay') throw new Error('provider connection lost after submission');
    if (unresolved) return { code: '099' } as never;
    return {
      code: '000',
      requestId: body.request_id,
      amount: '1000.00',
      content: {
        transactions: {
          status: 'delivered',
          transactionId: 'provider-receipt',
          unique_element: '1212121212',
        },
      },
    };
  });
  const provider = {
    assertEnabled: vi.fn(),
    environment: 'sandbox',
    balance: vi.fn(async () => new Prisma.Decimal('100000.00')),
    plans,
    verify: vi.fn(async () => ({ name, verified: true })),
    call,
  };
  beforeAll(async () => {
    ctx = await bootE2EApp({ overrides: [{ token: VtpassClient, useValue: provider }] });
    service = ctx.app.get(ServicePurchases);
    service.onModuleDestroy();
    const config = ctx.app.get(ConfigService);
    config.set('shopping', { ...config.get('shopping'), vtpassEnabled: true, serviceFee: '0.00' });
    vi.spyOn(ctx.app.get(PasscodeService), 'validate').mockResolvedValue(undefined);
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
    call.mockClear();
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
    expect(call.mock.calls.filter(([path]) => path === '/pay')).toHaveLength(1);
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
    expect(call.mock.calls.filter(([path]) => path === '/pay')).toHaveLength(1);
    expect(call.mock.calls.filter(([path]) => path === '/requery')).toHaveLength(1);
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
    expect(call.mock.calls.filter(([path]) => path === '/pay')).toHaveLength(1);
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
    call.mockResolvedValueOnce({ code: '016' } as never);
    await service.run();
    expect((await service.order(SEED_USER_ID, order.id)).status).toBe('FAILED');
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
    call.mockClear();
    await service.run();
    await service.run();
    expect(call).not.toHaveBeenCalled();
    expect(await available()).toBe('9000.00');
    expect(
      await ctx.prisma.notification.count({ where: { title: 'Subscription renewal reminder' } }),
    ).toBe(1);
    expect((await service.renewalQuote(SEED_USER_ID, order.id)).id).not.toBe(order.quote.id);
  });
});
