import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEED_USER_ID, seedBaseFixtures, truncateAll, type BootedE2EApp } from './e2e-app.js';
import {
  bootFinanceE2EApp,
  seedFinanceFunds,
  executeFinance,
  financeTestEnvironment,
} from './finance-fixtures.js';
const restoreEnvironment = financeTestEnvironment(4);
afterAll(restoreEnvironment);
describe('Transaction thresholds through passcode-bound finance commands', () => {
  let ctx: BootedE2EApp;
  beforeEach(async () => {
    ctx = await bootFinanceE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
    await seedFinanceFunds(ctx);
  });
  afterEach(async () => {
    await ctx.close();
  });
  it('lists the current user’s thresholds', async () => {
    const res = await ctx.http.get('/thresholds').expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      thresholdType: 'FIRST_TIME',
      thresholdValue: '1000.00',
    });
  });
  it('creates and updates one setting per type without creating duplicates', async () => {
    const fields = {
      kind: 'THRESHOLDS',
      thresholdType: 'LARGE_AMOUNT',
      thresholdValue: '5000.00',
      thresholdActive: true,
    };
    expect((await executeFinance(ctx, fields)).body.status).toBe('SUCCEEDED');
    expect(
      (await executeFinance(ctx, { ...fields, thresholdValue: '2500.00', thresholdActive: false }))
        .body.status,
    ).toBe('SUCCEEDED');
    const rows = await ctx.prisma.transactionThreshold.findMany({
      where: { userId: SEED_USER_ID, thresholdType: 'LARGE_AMOUNT' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].thresholdValue.toFixed(2)).toBe('2500.00');
    expect(rows[0].isActive).toBe(false);
    const list = await ctx.http.get('/thresholds').expect(200);
    expect(
      list.body.items.find(
        (row: { thresholdType: string }) => row.thresholdType === 'LARGE_AMOUNT',
      ),
    ).toMatchObject({ thresholdValue: '2500.00', isActive: false });
  });
  it('requires a bound proof and refuses obsolete direct writes', async () => {
    const list = await ctx.http.get('/thresholds').expect(200);
    const id = list.body.items[0].id as string;
    await ctx.http
      .post('/thresholds')
      .send({ thresholdType: 'LARGE_AMOUNT', thresholdValue: '1.00' })
      .expect(404);
    await ctx.http.patch(`/thresholds/${id}`).send({ thresholdValue: '1.00' }).expect(404);
    await ctx.http.delete(`/thresholds/${id}`).expect(404);
    await ctx.http
      .post('/finance/operations')
      .set('Idempotency-Key', 'unverified-threshold-123456')
      .send({
        command: {
          kind: 'THRESHOLDS',
          currency: 'NGN',
          amount: '0.00',
          fee: '0.00',
          thresholdType: 'FIRST_TIME',
          thresholdValue: '1.00',
          thresholdActive: false,
        },
        proof: 'invalid',
      })
      .expect(401);
    expect((await ctx.http.get(`/thresholds/${id}`).expect(200)).body.thresholdValue).toBe(
      '1000.00',
    );
  });
});
