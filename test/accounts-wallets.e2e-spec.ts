import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootE2EApp,
  SEED_ACCOUNT_ID,
  SEED_OTHER_ID,
  SEED_WALLET_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

describe('Account + wallet (self-service e2e)', () => {
  let ctx: BootedE2EApp;

  beforeEach(async () => {
    ctx = await bootE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('returns the current user’s single account', async () => {
    const res = await ctx.http.get('/account').expect(200);
    expect(res.body).toMatchObject({ id: SEED_ACCOUNT_ID, accountNumber: '0123456789' });
  });

  it('returns the wallet linked to the current user’s account', async () => {
    const res = await ctx.http.get('/wallet').expect(200);
    expect(res.body).toMatchObject({ id: SEED_WALLET_ID, balance: '5000.00', currency: 'NGN' });
  });

  it('404s account and wallet for a user who has not been provisioned', async () => {
    ctx.setPrincipal({ userId: SEED_OTHER_ID });
    const account = await ctx.http.get('/account').expect(404);
    expect(account.body.statusCode).toBe(404);
    const wallet = await ctx.http.get('/wallet').expect(404);
    expect(wallet.body.statusCode).toBe(404);
  });

  it('requires authentication for both surfaces', async () => {
    const account = await ctx.raw.get('/account').expect(401);
    expect(account.body.statusCode).toBe(401);
    const wallet = await ctx.raw.get('/wallet').expect(401);
    expect(wallet.body.statusCode).toBe(401);
  });

  it('creates the account and wallet for an unprovisioned user', async () => {
    ctx.setPrincipal({ userId: SEED_OTHER_ID });
    await ctx.http.get('/account').expect(404);

    const account = await ctx.http.post('/account').send({ accountType: 'SAVINGS' }).expect(201);
    expect(account.body.accountNumber).toMatch(/^\d{10}$/);

    const wallet = await ctx.http
      .post('/wallet')
      .send({ balance: '1000', currency: 'NGN' })
      .expect(201);
    expect(wallet.body).toMatchObject({ balance: '1000.00', currency: 'NGN', isActive: true });

    await ctx.http.get('/account').expect(200);
    await ctx.http.get('/wallet').expect(200);
  });

  it('rejects a second account and a second wallet (409)', async () => {
    await ctx.http.post('/account').send({}).expect(409);
    await ctx.http.post('/wallet').send({}).expect(409);
  });

  it('404s wallet creation before an account exists', async () => {
    ctx.setPrincipal({ userId: SEED_OTHER_ID });
    await ctx.http.post('/wallet').send({}).expect(404);
  });

  it('updates the account and wallet', async () => {
    const account = await ctx.http
      .patch('/account')
      .send({ accountType: 'SAVINGS', isActive: false })
      .expect(200);
    expect(account.body).toMatchObject({ accountType: 'SAVINGS', isActive: false });

    const wallet = await ctx.http
      .patch('/wallet')
      .send({ balance: '6000', isActive: false })
      .expect(200);
    expect(wallet.body).toMatchObject({ balance: '6000.00', isActive: false });
  });

  it('refuses to delete a wallet that still has transactions (400)', async () => {
    const res = await ctx.http.delete('/wallet').expect(400);
    expect(res.body.statusCode).toBe(400);
  });

  it('deletes a wallet that has no transactions', async () => {
    ctx.setPrincipal({ userId: SEED_OTHER_ID });
    await ctx.http.post('/account').send({}).expect(201);
    await ctx.http.post('/wallet').send({}).expect(201);

    await ctx.http.delete('/wallet').expect(200);
    await ctx.http.get('/wallet').expect(404);
    await ctx.http.get('/account').expect(200);
  });

  it('deletes the account, cascading the wallet', async () => {
    ctx.setPrincipal({ userId: SEED_OTHER_ID });
    const account = await ctx.http.post('/account').send({}).expect(201);
    await ctx.http.post('/wallet').send({}).expect(201);

    const result = await ctx.http.delete('/account').expect(200);
    expect(result.body).toEqual({ deleted: true, id: account.body.id });

    await ctx.http.get('/account').expect(404);
    await ctx.http.get('/wallet').expect(404);
  });
});
