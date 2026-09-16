import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardStatus, ProviderEventStatus } from '@prisma/client';
import { FLUTTERWAVE_CLIENT } from '../src/modules/flutterwave/flutterwave.client.js';
import {
  bootE2EApp,
  SEED_OTHER_ID,
  SEED_USER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';
import { makeFlutterwaveStub } from './flutterwave-stub.js';

describe('Issued (Flutterwave) cards e2e', () => {
  let ctx: BootedE2EApp;
  let stub: ReturnType<typeof makeFlutterwaveStub>['stub'];

  beforeEach(async () => {
    const fake = makeFlutterwaveStub();
    stub = fake.stub;
    ctx = await bootE2EApp({ overrides: [{ token: FLUTTERWAVE_CLIENT, useValue: stub }] });
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
  });

  afterEach(async () => {
    await ctx.close();
  });

  async function walletBalance(): Promise<string> {
    const res = await ctx.http.get('/wallet').expect(200);
    return res.body.balance;
  }

  describe('POST /api/cards/issued', () => {
    it('issues a prefunded NGN card, debits the wallet, and never leaks the PAN', async () => {
      const before = await walletBalance();

      const res = await ctx.http
        .post('/cards/issued')
        .send({ amount: '2000.00', billingName: 'Amina Sule', billingAddress: '1 Test St' })
        .expect(201);

      expect(res.body).toMatchObject({
        issuer: 'flutterwave',
        currency: 'NGN',
        cardType: 'virtual',
        cardNumberLast4: '8381',
        balance: '2000.00',
        status: CardStatus.ACTIVE,
      });
      expect(res.body.cardNumberEncrypted).toBeUndefined();
      expect(res.body.cardCvvEncrypted).toBeUndefined();
      expect(await walletBalance()).toBe((Number(before) - 2000).toFixed(2).padStart(5, '0'));

      expect(stub.createCard).toHaveBeenCalledTimes(1);
      const event = await ctx.prisma.providerEvent.findFirst({
        where: { eventType: 'card.issue' },
      });
      expect(event?.status).toBe(ProviderEventStatus.PROCESSED);

      const row = await ctx.prisma.card.findUnique({
        where: { id: res.body.id },
        select: {
          cardNumberEncrypted: true,
          cardCvvEncrypted: true,
          externalReferenceId: true,
          issuer: true,
        },
      });
      expect(row?.issuer).toBe('flutterwave');
      expect(row?.cardNumberEncrypted).toMatch(/^enc::/);
      expect(row?.cardCvvEncrypted).toMatch(/^enc::/);
      expect(row?.externalReferenceId).toBe('fw_card_1');
    });

    it('rejects issuance when the wallet cannot cover the prefund', async () => {
      await ctx.http.post('/cards/issued').send({ amount: '99999999.00' }).expect(400);
      expect(
        await ctx.prisma.card.count({ where: { userId: SEED_USER_ID, issuer: 'flutterwave' } }),
      ).toBe(0);
      expect(await walletBalance()).toBe('5000.00');
    });
  });

  describe('POST /api/cards/:id/fund and /withdraw', () => {
    it('funds from the wallet and withdraws back', async () => {
      const issued = await ctx.http.post('/cards/issued').send({ amount: '2000.00' }).expect(201);
      const id = issued.body.id as string;

      const funded = await ctx.http
        .post(`/cards/${id}/fund`)
        .send({ amount: '1000.00' })
        .expect(200);
      expect(funded.body.balance).toBe('3000.00');
      expect(await walletBalance()).toBe('2000.00');
      expect(stub.fundCard).toHaveBeenCalledWith('fw_card_1', '1000.00', undefined);

      const withdrawn = await ctx.http
        .post(`/cards/${id}/withdraw`)
        .send({ amount: '500.00' })
        .expect(200);
      expect(withdrawn.body.balance).toBe('2500.00');
      expect(await walletBalance()).toBe('2500.00');
      expect(stub.withdrawFromCard).toHaveBeenCalledWith('fw_card_1', '500.00');
    });

    it('refuses to fund past the wallet balance', async () => {
      const issued = await ctx.http.post('/cards/issued').send({ amount: '2000.00' }).expect(201);
      await ctx.http
        .post(`/cards/${issued.body.id}/fund`)
        .send({ amount: '99999999.00' })
        .expect(400);
      expect(stub.fundCard).not.toHaveBeenCalled();
    });

    it('404s for a card the user does not own', async () => {
      const issued = await ctx.http.post('/cards/issued').send({ amount: '2000.00' }).expect(201);
      ctx.setPrincipal({ userId: SEED_OTHER_ID });
      await ctx.http.post(`/cards/${issued.body.id}/fund`).send({ amount: '100.00' }).expect(404);
      await ctx.http
        .post(`/cards/${issued.body.id}/withdraw`)
        .send({ amount: '100.00' })
        .expect(404);
    });
  });

  describe('POST /api/cards/:id/cancel', () => {
    it('refuses to cancel a funded card and terminates an empty one', async () => {
      const issued = await ctx.http.post('/cards/issued').send({ amount: '2000.00' }).expect(201);
      const id = issued.body.id as string;
      await ctx.http.post(`/cards/${id}/cancel`).expect(400);

      await ctx.http.post(`/cards/${id}/withdraw`).send({ amount: '2000.00' }).expect(200);
      const cancelled = await ctx.http.post(`/cards/${id}/cancel`).expect(200);
      expect(cancelled.body.status).toBe(CardStatus.CANCELLED);
      expect(stub.terminateCard).toHaveBeenCalledWith('fw_card_1');
    });
  });

  describe('pause/resume on issued cards', () => {
    it('blocks/unblocks the provider card', async () => {
      const issued = await ctx.http.post('/cards/issued').send({ amount: '500.00' }).expect(201);
      const id = issued.body.id as string;

      const paused = await ctx.http.patch(`/cards/${id}/pause`).expect(200);
      expect(paused.body.status).toBe(CardStatus.PAUSED);
      expect(stub.blockCard).toHaveBeenCalledWith('fw_card_1');

      const resumed = await ctx.http.patch(`/cards/${id}/resume`).expect(200);
      expect(resumed.body.status).toBe(CardStatus.ACTIVE);
      expect(stub.unblockCard).toHaveBeenCalledWith('fw_card_1');
    });
  });

  describe('POST /api/cards/:id/transactions/sync', () => {
    it('records new spends, dedupes replays, and refreshes the balance', async () => {
      const issued = await ctx.http.post('/cards/issued').send({ amount: '2000.00' }).expect(201);
      const id = issued.body.id as string;

      stub.listCardTransactions = vi.fn(async () => [
        {
          id: 1,
          amount: 1200,
          currency: 'NGN',
          status: 'successful',
          narration: 'Lunch',
        },
        {
          id: 2,
          amount: 300,
          currency: 'NGN',
          status: 'successful',
          narration: 'Coffee',
        },
      ]) as typeof stub.listCardTransactions;
      stub.getCard = vi.fn(async () => ({
        id: 'fw_card_1',
        amount: 500,
        currency: 'NGN',
        cardPan: '************8381',
        maskedPan: '************8381',
        expiryMonth: '12',
        expiryYear: '29',
        cvv: '123',
        isActive: true,
        createdAt: new Date().toISOString(),
      })) as typeof stub.getCard;

      const first = await ctx.http.post(`/cards/${id}/transactions/sync`).expect(200);
      expect(first.body).toMatchObject({ newSpends: 2, balance: '500.00' });

      const second = await ctx.http.post(`/cards/${id}/transactions/sync`).expect(200);
      expect(second.body.newSpends).toBe(0);

      const spends = await ctx.prisma.transaction.findMany({
        where: { userId: SEED_USER_ID, type: 'PAYMENT', cardId: id },
        select: { amount: true, status: true },
      });
      expect(spends).toHaveLength(2);

      const card = await ctx.prisma.card.findUnique({ where: { id } });
      expect(card?.totalSpent.toNumber()).toBe(1500);
      expect(card?.lastSyncAt).toBeTruthy();
    });
  });
});
