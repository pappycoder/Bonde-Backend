import { randomUUID } from 'node:crypto';
import type { CardStatus, LockType } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootE2EApp,
  SEED_CARD_ID,
  SEED_OTHER_ID,
  SEED_USER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

describe('Cards self-service (e2e)', () => {
  let ctx: BootedE2EApp;

  beforeEach(async () => {
    ctx = await bootE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
  });

  afterEach(async () => {
    await ctx.close();
  });

  function seedCardFor(userId: string, status: CardStatus = 'ACTIVE') {
    return ctx.prisma.card.create({
      data: {
        id: randomUUID(),
        userId,
        providerId: '33333333-3333-4333-8333-333333333333',
        cardNumberEncrypted: 'enc::ciphertext',
        cardNumberLast4: '9999',
        cardType: 'virtual',
        status,
        expirationType: 'monthly',
        expirationDate: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
  }

  it('lists only the current user’s cards and never exposes the PAN', async () => {
    await seedCardFor(SEED_OTHER_ID);
    const res = await ctx.http.get('/cards').expect(200);
    expect(res.body).toMatchObject({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
    expect(res.body.items[0]).toMatchObject({ id: SEED_CARD_ID, cardNumberLast4: '4242' });
    expect(res.body.items[0]).not.toHaveProperty('cardNumberEncrypted');
  });

  it('gets one of the current user’s cards by id', async () => {
    const res = await ctx.http.get(`/cards/${SEED_CARD_ID}`).expect(200);
    expect(res.body).toMatchObject({ id: SEED_CARD_ID, status: 'ACTIVE' });
  });

  it('404s a card the user does not own', async () => {
    const foreign = await seedCardFor(SEED_OTHER_ID);
    const res = await ctx.http.get(`/cards/${foreign.id}`).expect(404);
    expect(res.body.statusCode).toBe(404);
  });

  it('pauses and resumes a card', async () => {
    const paused = await ctx.http.patch(`/cards/${SEED_CARD_ID}/pause`).expect(200);
    expect(paused.body.status).toBe('PAUSED');
    const resumed = await ctx.http.patch(`/cards/${SEED_CARD_ID}/resume`).expect(200);
    expect(resumed.body.status).toBe('ACTIVE');
  });

  it('rejects pausing a cancelled card (400)', async () => {
    const cancelled = await seedCardFor(SEED_USER_ID, 'CANCELLED');
    await ctx.http.patch(`/cards/${cancelled.id}/pause`).expect(400);
  });

  it('changes card limits and requires at least one', async () => {
    const ok = await ctx.http
      .patch(`/cards/${SEED_CARD_ID}/limit`)
      .send({ maxSpendLimit: '10000.00' })
      .expect(200);
    expect(ok.body.maxSpendLimit).toBe('10000.00');

    const bad = await ctx.http.patch(`/cards/${SEED_CARD_ID}/limit`).send({}).expect(400);
    expect(bad.body.statusCode).toBe(400);
  });

  describe('locks', () => {
    it('creates, lists, updates, gets and deletes a lock', async () => {
      const empty = await ctx.http.get(`/cards/${SEED_CARD_ID}/locks`).expect(200);
      expect(empty.body).toEqual([]);

      const created = await ctx.http
        .post(`/cards/${SEED_CARD_ID}/locks`)
        .send({ lockType: 'MERCHANT', config: { merchants: ['acme'] } })
        .expect(201);
      expect(created.body).toMatchObject({ lockType: 'MERCHANT', isActive: true });

      await ctx.http
        .post(`/cards/${SEED_CARD_ID}/locks`)
        .send({ lockType: 'MERCHANT' })
        .expect(409);

      const list = await ctx.http.get(`/cards/${SEED_CARD_ID}/locks`).expect(200);
      expect(list.body).toHaveLength(1);

      const got = await ctx.http.get(`/cards/${SEED_CARD_ID}/locks/${created.body.id}`).expect(200);
      expect(got.body.id).toBe(created.body.id);

      const patched = await ctx.http
        .patch(`/cards/${SEED_CARD_ID}/locks/${created.body.id}`)
        .send({ isActive: false })
        .expect(200);
      expect(patched.body.isActive).toBe(false);

      await ctx.http.delete(`/cards/${SEED_CARD_ID}/locks/${created.body.id}`).expect(200);
      const after = await ctx.http.get(`/cards/${SEED_CARD_ID}/locks`).expect(200);
      expect(after.body).toEqual([]);
    });

    it('enforces ownership on locks', async () => {
      const lock = await ctx.prisma.cardLock.create({
        data: {
          id: randomUUID(),
          cardId: (await seedCardFor(SEED_OTHER_ID)).id,
          lockType: 'TIME' as LockType,
        },
      });
      await ctx.http.get(`/cards/${lock.cardId}/locks`).expect(404);
      await ctx.http.delete(`/cards/${lock.cardId}/locks/${lock.id}`).expect(404);
    });
  });

  describe('restricted categories', () => {
    it('creates, toggles, gets and deletes a category', async () => {
      const created = await ctx.http
        .post(`/cards/${SEED_CARD_ID}/categories`)
        .send({ category: 'FOOD_RESTAURANT', isAllowed: true })
        .expect(201);
      expect(created.body).toMatchObject({ category: 'FOOD_RESTAURANT', isAllowed: true });

      await ctx.http
        .post(`/cards/${SEED_CARD_ID}/categories`)
        .send({ category: 'FOOD_RESTAURANT' })
        .expect(409);

      const list = await ctx.http.get(`/cards/${SEED_CARD_ID}/categories`).expect(200);
      expect(list.body).toHaveLength(1);

      const got = await ctx.http
        .get(`/cards/${SEED_CARD_ID}/categories/${created.body.id}`)
        .expect(200);
      expect(got.body.id).toBe(created.body.id);

      const patched = await ctx.http
        .patch(`/cards/${SEED_CARD_ID}/categories/${created.body.id}`)
        .send({ isAllowed: false })
        .expect(200);
      expect(patched.body.isAllowed).toBe(false);

      await ctx.http.delete(`/cards/${SEED_CARD_ID}/categories/${created.body.id}`).expect(200);
    });
  });
});
