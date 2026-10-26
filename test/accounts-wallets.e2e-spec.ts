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
describe('Ledger account and wallet presentation', () => {
  let ctx: BootedE2EApp;
  beforeEach(async () => {
    ctx = await bootE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
  });
  afterEach(async () => {
    await ctx.close();
  });
  it('does not expose a historical sample account number as a deposit account', async () => {
    const response = await ctx.http.get('/account').expect(200);
    expect(response.body).toMatchObject({ id: SEED_ACCOUNT_ID, accountNumber: '' });
  });
  it('does not import sample wallet balances into the live ledger', async () => {
    const response = await ctx.http.get('/wallet').expect(200);
    expect(response.body).toMatchObject({
      id: SEED_WALLET_ID,
      balance: '0.00',
      allocated: '0.00',
      held: '0.00',
      live: true,
    });
  });
  it('rejects unprovisioned users', async () => {
    ctx.setPrincipal({ userId: SEED_OTHER_ID });
    await ctx.http.get('/account').expect(404);
    await ctx.http.get('/wallet').expect(404);
  });
  it('requires authentication', async () => {
    await ctx.raw.get('/wallet').expect(401);
    await ctx.raw.get('/account').expect(401);
  });
  it.each(['/wallet', '/account'])('removes arbitrary financial CRUD at %s', async (path) => {
    await ctx.http.post(path).send({ balance: '99999' }).expect(404);
    await ctx.http.patch(path).send({ balance: '99999' }).expect(404);
    await ctx.http.delete(path).expect(404);
  });
});
