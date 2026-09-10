import { randomUUID } from 'node:crypto';
import type { CardStatus, LockType } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAIL_SENDER, type MailMessage, type MailSender } from '../src/common/mail/mail.types.js';
import {
  bootE2EApp,
  SEED_CARD_ID,
  SEED_OTHER_ID,
  SEED_USER_EMAIL,
  SEED_USER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

describe('Cards self-service (e2e)', () => {
  let ctx: BootedE2EApp;
  let sentMails: MailMessage[];
  let failNextMail: boolean;
  const mailSender: MailSender = {
    send: async (message) => {
      if (failNextMail) throw new Error('mail down');
      sentMails.push(message);
    },
  };

  beforeEach(async () => {
    sentMails = [];
    failNextMail = false;
    ctx = await bootE2EApp({ overrides: [{ token: MAIL_SENDER, useValue: mailSender }] });
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

  describe('create & patch', () => {
    it('creates a virtual card, never exposing the PAN', async () => {
      const res = await ctx.http
        .post('/cards')
        .send({ nickname: 'Delivery', maxSpendLimit: '5000', expirationType: 'yearly' })
        .expect(201);
      expect(res.body).toMatchObject({
        userId: SEED_USER_ID,
        cardType: 'virtual',
        nickname: 'Delivery',
        status: 'ACTIVE',
        maxSpendLimit: '5000.00',
      });
      expect(res.body.cardNumberLast4).toMatch(/^\d{4}$/);
      expect(res.body).not.toHaveProperty('cardNumberEncrypted');

      const created = await ctx.prisma.card.findUnique({ where: { id: res.body.id } });
      expect(created?.cardNumberEncrypted).toMatch(/^enc::/);
      const hist = await ctx.prisma.cardHistory.findMany({
        where: { cardId: res.body.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(hist).toHaveLength(1);
      expect(hist[0].event).toBe('create');

      expect(sentMails).toHaveLength(1);
      expect(sentMails[0].to).toBe(SEED_USER_EMAIL);
      expect(sentMails[0].subject).toContain('ending in');
      expect(sentMails[0].html).toContain(res.body.cardNumberLast4);
    });

    it('creates the card even when the notification email delivery fails', async () => {
      failNextMail = true;
      const res = await ctx.http
        .post('/cards')
        .send({ nickname: 'Delivery', maxSpendLimit: '5000' })
        .expect(201);
      expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(sentMails).toHaveLength(0);
    });

    it('rejects an unsupported card type', async () => {
      await ctx.http.post('/cards').send({ cardType: 'physical' }).expect(400);
    });

    it('patches nickname and normalizes limits', async () => {
      const patched = await ctx.http
        .patch(`/cards/${SEED_CARD_ID}`)
        .send({ nickname: 'Groceries', monthlyLimit: '25000' })
        .expect(200);
      expect(patched.body.nickname).toBe('Groceries');
      expect(patched.body.monthlyLimit).toBe('25000.00');

      const last = await ctx.prisma.cardHistory.findFirst({
        where: { cardId: SEED_CARD_ID },
        orderBy: { createdAt: 'desc' },
      });
      expect(last?.event).toBe('update');
      expect(last?.changes).toMatchObject({
        before: { nickname: null, monthlyLimit: null },
        after: { nickname: 'Groceries', monthlyLimit: '25000.00' },
      });
    });

    it('rejects an empty patch', async () => {
      await ctx.http.patch(`/cards/${SEED_CARD_ID}`).send({}).expect(400);
    });
  });

  describe('history', () => {
    it('trails card events newest first', async () => {
      await ctx.http.patch(`/cards/${SEED_CARD_ID}/pause`).expect(200);
      await ctx.http.patch(`/cards/${SEED_CARD_ID}/resume`).expect(200);
      await ctx.http
        .post(`/cards/${SEED_CARD_ID}/locks`)
        .send({ lockType: 'TIME', config: { days: 3 } })
        .expect(201);

      const res = await ctx.http.get(`/cards/${SEED_CARD_ID}/history`).expect(200);
      const events = res.body.map((h: { event: string }) => h.event);
      expect(events).toEqual(['lock.create', 'resume', 'pause']);
    });

    it('404s a foreign card’s history', async () => {
      const foreign = await seedCardFor(SEED_OTHER_ID);
      await ctx.http.get(`/cards/${foreign.id}/history`).expect(404);
    });
  });

  describe('merchants (allowlist)', () => {
    it('lists the seeded merchant and adds/removes another', async () => {
      const list = await ctx.http.get(`/cards/${SEED_CARD_ID}/merchants`).expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({ merchantName: 'Acme Stores', merchantCode: 'M-ACME-001' }),
      ]);

      const added = await ctx.http
        .post(`/cards/${SEED_CARD_ID}/merchants`)
        .send({ merchantName: 'Global Mart', merchantCode: 'M-GM-002' })
        .expect(201);
      expect(added.body).toMatchObject({ merchantName: 'Global Mart' });
      expect(added.body).not.toHaveProperty('cardNumberEncrypted');

      const removed = await ctx.http
        .delete(`/cards/${SEED_CARD_ID}/merchants/${added.body.id}`)
        .expect(200);
      expect(removed.body).toEqual({ deleted: true, id: added.body.id });
    });

    it('409s duplicate merchants (by code and by name)', async () => {
      await ctx.http
        .post(`/cards/${SEED_CARD_ID}/merchants`)
        .send({ merchantName: 'Acme Stores', merchantCode: 'M-ACME-001' })
        .expect(409);
      await ctx.http
        .post(`/cards/${SEED_CARD_ID}/merchants`)
        .send({ merchantName: 'acme stores' })
        .expect(409);
    });

    it('404s merchant operations on a foreign card', async () => {
      const foreign = await seedCardFor(SEED_OTHER_ID);
      await ctx.http.get(`/cards/${foreign.id}/merchants`).expect(404);
      await ctx.http
        .post(`/cards/${foreign.id}/merchants`)
        .send({ merchantName: 'Acme' })
        .expect(404);
      await ctx.http.delete(`/cards/${foreign.id}/merchants/${randomUUID()}`).expect(404);
    });
  });
});
