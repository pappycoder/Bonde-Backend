import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SEED_USER_ID,
  SEED_CARD_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';
import { bootFinanceE2EApp, financeTestEnvironment, seedFinanceFunds } from './finance-fixtures.js';

const restore = financeTestEnvironment(6);
afterAll(restore);
describe('abandoned mobile payment keys', () => {
  let ctx: BootedE2EApp;
  const command = {
    kind: 'ALLOCATE',
    currency: 'NGN',
    amount: '10.00',
    fee: '0.00',
    cardId: SEED_CARD_ID,
  };
  const key = 'unsubmitted-mobile-key-123';
  beforeEach(async () => {
    ctx = await bootFinanceE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
    await seedFinanceFunds(ctx);
  });
  afterEach(async () => {
    await ctx.app.close();
  });
  async function submit(proof: string) {
    return ctx.http
      .post('/finance/operations')
      .set('Idempotency-Key', key)
      .send({ command, proof });
  }
  async function proof() {
    return (await ctx.http.post('/finance/proof').send({ command, passcode: '1234' }).expect(201))
      .body.proof as string;
  }
  it('fences a delayed submission without moving money or consuming its proof', async () => {
    const token = await proof();
    const abandoned = await ctx.http
      .post(`/finance/operation-key/${key}/abandon`)
      .send(command)
      .expect(200);
    expect(abandoned.body.status).toBe('SUPERSEDED');
    expect((await submit(token)).body.status).toBe('SUPERSEDED');
    expect(await ctx.prisma.financeJournal.count()).toBe(1);
    expect(
      (
        await ctx.prisma.financeAccount.findUniqueOrThrow({
          where: { key: `wallet:${SEED_USER_ID}:NGN` },
        })
      ).balance.toFixed(2),
    ).toBe('100.00');
  });
  it('cannot abandon a request already accepted or spend it twice during a race', async () => {
    const token = await proof();
    const [sent] = await Promise.all([
      submit(token),
      ctx.http.post(`/finance/operation-key/${key}/abandon`).send(command),
    ]);
    expect(['SUCCEEDED', 'SUPERSEDED']).toContain(sent.body.status);
    const op = await ctx.prisma.financeOperation.findUniqueOrThrow({
      where: { userId_idempotencyKey: { userId: SEED_USER_ID, idempotencyKey: key } },
    });
    const retry = await ctx.http
      .post(`/finance/operation-key/${key}/abandon`)
      .send(command)
      .expect(200);
    expect(retry.body.status).toBe(op.status);
    expect(await ctx.prisma.financeJournal.count()).toBe(op.status === 'SUCCEEDED' ? 2 : 1);
  });
  it('rejects an attempt to replace an existing key with another command', async () => {
    await ctx.http.post(`/finance/operation-key/${key}/abandon`).send(command).expect(200);
    await ctx.http
      .post(`/finance/operation-key/${key}/abandon`)
      .send({ ...command, amount: '20.00' })
      .expect(409);
  });
});
