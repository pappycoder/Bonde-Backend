import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2EApp, seedBaseFixtures, truncateAll, type BootedE2EApp } from './e2e-app.js';
describe('Banking identity status', () => {
  let ctx: BootedE2EApp;
  beforeEach(async () => {
    ctx = await bootE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
  });
  afterEach(async () => {
    await ctx.close();
  });
  it('uses banking onboarding and removes the separate identity verification write', async () => {
    const result = await ctx.http.get('/kyc').expect(200);
    expect(result.body).toMatchObject({ status: 'PENDING', identityVerified: false });
    await ctx.http.post('/kyc/verify').send({ bvn: '12345678901', nin: '12345678901' }).expect(404);
  });
});
