import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  bootE2EApp,
  seedBaseFixtures,
  truncateAll,
  SEED_USER_ID,
  SEED_OTHER_ID,
  SEED_WALLET_ID,
  type BootedE2EApp,
} from './e2e-app.js';
import { PasscodeService } from '../src/modules/passcode/passcode.service.js';

describe('Profile hub and billing (local database)', () => {
  let ctx: BootedE2EApp;
  beforeEach(async () => {
    ctx = await bootE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
    await ctx.app.get(PasscodeService).create(SEED_USER_ID, '1234');
    await ctx.prisma.wallet.update({
      where: { id: SEED_WALLET_ID },
      data: { balance: '20000.00' },
    });
  });
  afterEach(async () => {
    await ctx.close();
  });
  it('persists only allowed preferences and keeps them owner scoped', async () => {
    await ctx.http
      .patch('/profile/preferences')
      .send({ theme: 'light', hideBalances: true })
      .expect(200);
    expect((await ctx.http.get('/profile/preferences').expect(200)).body).toMatchObject({
      theme: 'light',
      hideBalances: true,
    });
    await ctx.http.patch('/profile/preferences').send({ cardPlan: 'PREMIUM' }).expect(400);
    ctx.setPrincipal({ userId: SEED_OTHER_ID });
    expect((await ctx.http.get('/profile/preferences').expect(200)).body.hideBalances).toBe(false);
  });
  it('uses fixed catalog prices and serializes concurrent confirmations', async () => {
    const quote = await ctx.http
      .post('/billing/orders')
      .send({ idempotencyKey: randomUUID(), productId: 'pack-50', paymentMethod: 'WALLET' })
      .expect(201);
    expect(quote.body.amount).toBe('6000.00');
    const results = await Promise.all([
      ctx.http.post(`/billing/orders/${quote.body.id}/confirm`).send({ passcode: '1234' }),
      ctx.http.post(`/billing/orders/${quote.body.id}/confirm`).send({ passcode: '1234' }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0].body.transactionId).toBe(results[1].body.transactionId);
    expect(
      (
        await ctx.prisma.wallet.findUniqueOrThrow({ where: { id: SEED_WALLET_ID } })
      ).balance.toFixed(2),
    ).toBe('14000.00');
    expect(
      (await ctx.prisma.aiCreditAccount.findUniqueOrThrow({ where: { userId: SEED_USER_ID } }))
        .purchasedRemaining,
    ).toBe(50);
    expect(
      await ctx.prisma.billingOrder.count({ where: { userId: SEED_USER_ID, status: 'SUCCESS' } }),
    ).toBe(1);
  });
  it('does not accept client amounts, and hides orders from other accounts', async () => {
    await ctx.http
      .post('/billing/orders')
      .send({
        idempotencyKey: randomUUID(),
        productId: 'pack-50',
        paymentMethod: 'WALLET',
        amount: '1.00',
      })
      .expect(400);
    const order = await ctx.http
      .post('/billing/orders')
      .send({ idempotencyKey: randomUUID(), productId: 'pack-50', paymentMethod: 'WALLET' })
      .expect(201);
    ctx.setPrincipal({ userId: SEED_OTHER_ID });
    await ctx.http.get(`/billing/orders/${order.body.id}`).expect(404);
  });
  it('creates support requests that another user cannot access', async () => {
    const ticket = await ctx.http
      .post('/profile/support')
      .send({ subject: 'Wallet question', message: 'Please help me with my wallet balance.' })
      .expect(201);
    ctx.setPrincipal({ userId: SEED_OTHER_ID });
    await ctx.http.get(`/profile/support/${ticket.body.id}`).expect(404);
  });
  it('appends owner replies, rejects foreign and resolved conversations', async () => {
    const created = await ctx.http
      .post('/profile/support')
      .send({ subject: 'Profile question', message: 'Please help with my account.' })
      .expect(201);
    const id = created.body.id;
    const reply = await ctx.http
      .post(`/profile/support/${id}/messages`)
      .send({ message: '  Here is more detail.  ' })
      .expect(201);
    expect(reply.body.messages).toHaveLength(2);
    expect(reply.body.messages[1]).toMatchObject({ role: 'USER', body: 'Here is more detail.' });
    await ctx.http.post(`/profile/support/${id}/messages`).send({ message: '   ' }).expect(400);
    ctx.setPrincipal({ userId: SEED_OTHER_ID });
    await ctx.http
      .post(`/profile/support/${id}/messages`)
      .send({ message: 'Not my ticket' })
      .expect(404);
    ctx.setPrincipal({ userId: SEED_USER_ID });
    await ctx.prisma.supportTicket.update({ where: { id }, data: { status: 'RESOLVED' } });
    await ctx.http
      .post(`/profile/support/${id}/messages`)
      .send({ message: 'No longer open' })
      .expect(409);
    expect(await ctx.prisma.supportMessage.count({ where: { ticketId: id } })).toBe(2);
  });
});
