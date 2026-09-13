import { randomUUID } from 'node:crypto';
import { AccountType } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootE2EApp,
  SEED_APPROVAL_ID,
  SEED_CARD_ID,
  SEED_OTHER_ID,
  SEED_TRANSACTION_ID,
  SEED_USER_ID,
  SEED_WALLET_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

describe('Transactions, approvals + thresholds (self-service e2e)', () => {
  let ctx: BootedE2EApp;

  beforeEach(async () => {
    ctx = await bootE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
  });

  afterEach(async () => {
    await ctx.close();
  });

  async function seedTxFor(userId: string) {
    const account = await ctx.prisma.account.create({
      data: {
        id: randomUUID(),
        userId,
        accountNumber: `11${randomUUID().replace(/-/g, '').slice(0, 8)}`,
        accountType: AccountType.CHECKING,
      },
    });
    const wallet = await ctx.prisma.wallet.create({
      data: { id: randomUUID(), accountId: account.id, balance: '0.00', currency: 'NGN' },
    });
    return ctx.prisma.transaction.create({
      data: {
        id: randomUUID(),
        userId,
        walletId: wallet.id,
        type: 'WITHDRAWAL',
        status: 'SUCCESS',
        approvalStatus: 'DECLINED',
        amount: '500.00',
        currency: 'NGN',
      },
    });
  }

  it('lists only the current user’s transactions, paged with string decimals', async () => {
    await seedTxFor(SEED_OTHER_ID);
    const res = await ctx.http.get('/transactions').expect(200);
    expect(res.body).toMatchObject({ total: 1 });
    expect(res.body.items[0]).toMatchObject({ id: SEED_TRANSACTION_ID, amount: '2500.00' });
  });

  it('filters transactions by status', async () => {
    const pending = await ctx.http
      .get('/transactions')
      .query({ filter: 'status:PENDING' })
      .expect(200);
    expect(pending.body.total).toBe(1);
    const success = await ctx.http
      .get('/transactions')
      .query({ filter: 'status:SUCCESS' })
      .expect(200);
    expect(success.body.total).toBe(0);
  });

  it('searches transactions by description and rejects bad filters', async () => {
    const res = await ctx.http.get('/transactions').query({ q: 'amina' }).expect(200);
    expect(res.body).toMatchObject({ total: 1, items: [{ id: SEED_TRANSACTION_ID }] });

    await ctx.http.get('/transactions').query({ q: 'na' }).expect(200);
    await ctx.http.get('/transactions').query({ filter: 'nope:x' }).expect(400);
    await ctx.http.get('/transactions').query({ filter: 'status:contains:EN' }).expect(400);
  });

  it('returns recent transactions as a bounded array', async () => {
    const res = await ctx.http.get('/transactions/recent').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ id: SEED_TRANSACTION_ID });
  });

  it('gets one of the current user’s transactions', async () => {
    const res = await ctx.http.get(`/transactions/${SEED_TRANSACTION_ID}`).expect(200);
    expect(res.body.id).toBe(SEED_TRANSACTION_ID);
  });

  it('404s a foreign transaction', async () => {
    const foreign = await seedTxFor(SEED_OTHER_ID);
    await ctx.http.get(`/transactions/${foreign.id}`).expect(404);
  });

  it('lists approvals on the current user’s transactions and filters by status', async () => {
    const list = await ctx.http.get('/approvals').expect(200);
    expect(list.body).toMatchObject({ total: 1 });
    expect(list.body.items[0]).toMatchObject({
      id: SEED_APPROVAL_ID,
      status: 'PENDING',
      transaction: { id: SEED_TRANSACTION_ID, amount: '2500.00', type: 'PAYMENT' },
      card: {
        id: SEED_CARD_ID,
        cardNumberLast4: '4242',
        cardType: 'virtual',
        totalSpent: '0.00',
      },
    });

    const declined = await ctx.http
      .get('/approvals')
      .query({ filter: 'status:DECLINED' })
      .expect(200);
    expect(declined.body.total).toBe(0);
  });

  it('gets one approval with its transaction and card embedded', async () => {
    const res = await ctx.http.get(`/approvals/${SEED_APPROVAL_ID}`).expect(200);
    expect(res.body.id).toBe(SEED_APPROVAL_ID);
    expect(res.body.transaction).toMatchObject({ id: SEED_TRANSACTION_ID, amount: '2500.00' });
    expect(res.body.card).toMatchObject({ id: SEED_CARD_ID, totalSpent: '0.00' });
  });

  it('404s approvals belonging to a foreign transaction', async () => {
    const foreign = await seedTxFor(SEED_OTHER_ID);
    const approval = await ctx.prisma.transactionApproval.create({
      data: {
        id: randomUUID(),
        transactionId: foreign.id,
        status: 'APPROVED',
        approvedBy: SEED_OTHER_ID,
      },
    });
    await ctx.http.get(`/approvals/${approval.id}`).expect(404);
  });

  it('lists the current user’s thresholds', async () => {
    const res = await ctx.http.get('/thresholds').expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      thresholdType: 'FIRST_TIME',
      thresholdValue: '1000.00',
    });
  });

  it('creates a threshold and rejects a duplicate type (409)', async () => {
    const created = await ctx.http
      .post('/thresholds')
      .send({ thresholdType: 'LARGE_AMOUNT', thresholdValue: '5000.00' })
      .expect(201);
    expect(created.body).toMatchObject({ thresholdType: 'LARGE_AMOUNT', isActive: true });

    await ctx.http
      .post('/thresholds')
      .send({ thresholdType: 'FIRST_TIME', thresholdValue: '1.00' })
      .expect(409);
  });

  it('updates and deletes an owned threshold', async () => {
    const list = await ctx.http.get('/thresholds').expect(200);
    const id = list.body.items[0].id as string;

    const updated = await ctx.http
      .patch(`/thresholds/${id}`)
      .send({ thresholdValue: '2500.00', isActive: false })
      .expect(200);
    expect(updated.body).toMatchObject({ thresholdValue: '2500.00', isActive: false });

    await ctx.http.delete(`/thresholds/${id}`).expect(200);
    await ctx.http.get(`/thresholds/${id}`).expect(404);
  });

  it('records a transaction via POST scoped to the user', async () => {
    const created = await ctx.http
      .post('/transactions')
      .send({ walletId: SEED_WALLET_ID, type: 'WITHDRAWAL', amount: '500', description: 'ATM' })
      .expect(201);
    expect(created.body).toMatchObject({
      userId: SEED_USER_ID,
      amount: '500.00',
      status: 'PENDING',
      approvalStatus: 'PENDING',
    });

    const list = await ctx.http
      .get('/transactions')
      .query({ filter: 'status:PENDING' })
      .expect(200);
    expect(list.body.total).toBe(2);
  });

  it('404s a transaction referencing a foreign wallet', async () => {
    const foreignWallet = await seedTxFor(SEED_OTHER_ID);
    const walletId = foreignWallet.walletId as string;
    await ctx.http
      .post('/transactions')
      .send({ walletId, type: 'WITHDRAWAL', amount: '500.00' })
      .expect(404);
  });

  it('updates and deletes an owned transaction', async () => {
    const updated = await ctx.http
      .patch(`/transactions/${SEED_TRANSACTION_ID}`)
      .send({ status: 'SUCCESS', approvalStatus: 'APPROVED', approvalNotes: 'ok' })
      .expect(200);
    expect(updated.body).toMatchObject({ status: 'SUCCESS', approvalStatus: 'APPROVED' });

    await ctx.http.delete(`/transactions/${SEED_TRANSACTION_ID}`).expect(200);
    await ctx.http.get(`/transactions/${SEED_TRANSACTION_ID}`).expect(404);
  });

  it('records, updates and deletes an approval on an owned transaction', async () => {
    const created = await ctx.http
      .post('/approvals')
      .send({ transactionId: SEED_TRANSACTION_ID, status: 'APPROVED', notes: 'yes' })
      .expect(201);
    expect(created.body).toMatchObject({ approvedBy: SEED_USER_ID, status: 'APPROVED' });

    const patched = await ctx.http
      .patch(`/approvals/${created.body.id}`)
      .send({ status: 'DECLINED' })
      .expect(200);
    expect(patched.body).toMatchObject({ status: 'DECLINED' });

    await ctx.http.delete(`/approvals/${created.body.id}`).expect(200);
    await ctx.http.get(`/approvals/${created.body.id}`).expect(404);
  });

  it('404s creating an approval on a foreign transaction', async () => {
    const foreign = await seedTxFor(SEED_OTHER_ID);
    await ctx.http.post('/approvals').send({ transactionId: foreign.id }).expect(404);
  });

  it('tracks cumulative card spend for successful PAYMENTs across create/update/delete', async () => {
    const created = await ctx.http
      .post('/transactions')
      .send({
        walletId: SEED_WALLET_ID,
        type: 'PAYMENT',
        amount: '1500.00',
        status: 'SUCCESS',
        cardId: SEED_CARD_ID,
      })
      .expect(201);

    const card = await ctx.http.get(`/cards/${SEED_CARD_ID}`).expect(200);
    expect(card.body.totalSpent).toBe('1500.00');

    const approval = await ctx.http
      .post('/approvals')
      .send({ transactionId: created.body.id })
      .expect(201);
    expect(approval.body.card).toMatchObject({ id: SEED_CARD_ID, totalSpent: '1500.00' });

    await ctx.http.patch(`/transactions/${created.body.id}`).send({ status: 'FAIL' }).expect(200);
    const afterFail = await ctx.http.get(`/cards/${SEED_CARD_ID}`).expect(200);
    expect(afterFail.body.totalSpent).toBe('0.00');

    await ctx.http.delete(`/transactions/${created.body.id}`).expect(200);
    const afterDelete = await ctx.http.get(`/cards/${SEED_CARD_ID}`).expect(200);
    expect(afterDelete.body.totalSpent).toBe('0.00');
  });
});
