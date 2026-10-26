import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2EApp, seedBaseFixtures, truncateAll, type BootedE2EApp } from './e2e-app.js';
describe('Transaction thresholds', () => {
  let ctx: BootedE2EApp;
  beforeEach(async () => {
    ctx = await bootE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
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
});
