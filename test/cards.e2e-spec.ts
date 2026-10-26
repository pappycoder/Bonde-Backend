import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootE2EApp,
  SEED_CARD_ID,
  SEED_OTHER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';
describe('Sudo card presentation', () => {
  let ctx: BootedE2EApp;
  beforeEach(async () => {
    ctx = await bootE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
  });
  afterEach(async () => {
    await ctx.close();
  });
  it('excludes historical sample cards', async () => {
    const response = await ctx.http.get('/cards').expect(200);
    expect(response.body.total).toBe(0);
  });
  it('returns masked provider cards and their ledger allocation', async () => {
    await ctx.prisma.card.update({ where: { id: SEED_CARD_ID }, data: { issuer: 'sudo' } });
    const response = await ctx.http.get(`/cards/${SEED_CARD_ID}`).expect(200);
    expect(response.body.balance).toBe('0.00');
    expect(response.body).not.toHaveProperty('cardNumberEncrypted');
    expect(response.body).not.toHaveProperty('cardCvvEncrypted');
    ctx.setPrincipal({ userId: SEED_OTHER_ID });
    await ctx.http.get(`/cards/${SEED_CARD_ID}`).expect(404);
  });
  it('removes raw credentials and direct card mutations', async () => {
    await ctx.http.get(`/cards/${SEED_CARD_ID}/credentials`).expect(404);
    await ctx.http.post('/cards').send({ nickname: 'sample' }).expect(404);
    await ctx.http.patch(`/cards/${SEED_CARD_ID}/pause`).expect(404);
    await ctx.http.post(`/cards/${SEED_CARD_ID}/fund`).send({ amount: '10' }).expect(404);
    await ctx.http.post('/transactions').send({ amount: '999', status: 'SUCCESS' }).expect(404);
    await ctx.http.post('/approvals').send({ status: 'APPROVED' }).expect(404);
  });
});
