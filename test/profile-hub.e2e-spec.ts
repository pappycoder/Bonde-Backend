import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  seedBaseFixtures,
  truncateAll,
  SEED_USER_ID,
  SEED_OTHER_ID,
  type BootedE2EApp,
} from './e2e-app.js';
import { ConfigService } from '@nestjs/config';
import { bootFinanceE2EApp, seedFinanceFunds, financeTestEnvironment } from './finance-fixtures.js';
const restoreEnvironment = financeTestEnvironment(6);
afterAll(restoreEnvironment);

describe('Profile hub and billing (local database)', () => {
  let ctx: BootedE2EApp;
  beforeEach(async () => {
    ctx = await bootFinanceE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
    const config = ctx.app.get(ConfigService);
    config.set('profileHub', { ...config.get('profileHub'), billingEnabled: true });
    await seedFinanceFunds(ctx, '20000.00');
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
  it('manages owner-scoped saved addresses without exposing them to another user', async () => {
    expect((await ctx.http.get('/profile/addresses').expect(200)).body).toEqual([]);
    const address = {
      recipientName: ' Tunde Bakare ',
      recipientPhone: '09034688362',
      street: ' 10 Test Road ',
      addressLine2: '',
      city: 'Lagos',
      region: 'Lagos',
      lga: 'Ikorodu',
      country: 'Nigeria',
      postalCode: '00100',
    };
    const created = await ctx.http.post('/profile/addresses').send(address).expect(201);
    expect(created.body).toMatchObject({
      recipientName: 'Tunde Bakare',
      street: '10 Test Road',
      isDefault: true,
    });
    const second = await ctx.http
      .post('/profile/addresses')
      .send({ ...address, street: '20 New Road' })
      .expect(201);
    expect(second.body.isDefault).toBe(false);
    await ctx.http
      .patch(`/profile/addresses/${second.body.id}`)
      .send({ ...address, street: '22 Updated Road', city: 'Ikoyi', lga: 'Lagos Island' })
      .expect(200);
    await ctx.http.post(`/profile/addresses/${second.body.id}/default`).expect(200);
    const list = (await ctx.http.get('/profile/addresses').expect(200)).body;
    expect(list.map((entry: { id: string }) => entry.id)).toEqual([
      second.body.id,
      created.body.id,
    ]);
    expect(list[0]).toMatchObject({ isDefault: true, street: '22 Updated Road' });
    await ctx.http.delete(`/profile/addresses/${second.body.id}`).expect(200);
    const after = (await ctx.http.get('/profile/addresses').expect(200)).body;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: created.body.id, isDefault: true });
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'profile.delivery_address.update' },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.metadata ?? {})).not.toContain('Road');
    ctx.setPrincipal({ userId: SEED_OTHER_ID });
    expect((await ctx.http.get('/profile/addresses').expect(200)).body).toEqual([]);
    await ctx.http.patch(`/profile/addresses/${created.body.id}`).send(address).expect(404);
    await ctx.http.delete(`/profile/addresses/${created.body.id}`).expect(404);
    await ctx.http
      .post('/profile/addresses')
      .send({ ...address, userId: SEED_USER_ID })
      .expect(400);
    await ctx.raw.get('/profile/addresses').expect(401);
    await ctx.raw.post('/profile/addresses').send(address).expect(401);
  });
  it('rejects incomplete delivery addresses without saving them', async () => {
    await ctx.http.post('/profile/addresses').send({ street: ' ', country: 'Nigeria' }).expect(400);
    expect(await ctx.prisma.deliveryAddress.count()).toBe(0);
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
        await ctx.prisma.financeAccount.findUniqueOrThrow({
          where: { key: `wallet:${SEED_USER_ID}:NGN` },
        })
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
