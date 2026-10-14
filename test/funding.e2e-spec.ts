import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../src/config/configuration.js';
import { FLUTTERWAVE_CLIENT } from '../src/modules/flutterwave/flutterwave.client.js';
import {
  bootE2EApp,
  SEED_USER_ID,
  SEED_OTHER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';
import { makeFlutterwaveStub } from './flutterwave-stub.js';

describe('Funding (deposit accounts, withdrawals, webhooks) e2e', () => {
  let ctx: BootedE2EApp;
  let stub: ReturnType<typeof makeFlutterwaveStub>['stub'];

  beforeEach(async () => {
    // The withdrawals route is @StrictThrottle() — lift the lockout for this suite.
    process.env.THROTTLE_STRICT_LIMIT = '1000';
    process.env.THROTTLE_STRICT_BLOCK_DURATION = '0';
    const fake = makeFlutterwaveStub();
    stub = fake.stub;
    ctx = await bootE2EApp({ overrides: [{ token: FLUTTERWAVE_CLIENT, useValue: stub }] });
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
  });

  afterEach(async () => {
    delete process.env.THROTTLE_STRICT_LIMIT;
    delete process.env.THROTTLE_STRICT_BLOCK_DURATION;
    await ctx.close();
  });

  function webhookSecret(): string {
    return ctx.app.get<ConfigService<AppConfig, true>>(ConfigService).get('flutterwave')
      .webhookSecretHash;
  }

  async function postWebhook(event: string, data: Record<string, unknown>): Promise<string> {
    const body = JSON.stringify({ event, data });
    await ctx.raw
      .post('/flutterwave/webhook')
      .set('Content-Type', 'application/json')
      .set('verif-hash', webhookSecret())
      .send(body)
      .expect(200);
    return body;
  }

  async function walletBalance(): Promise<string> {
    const res = await ctx.http.get('/wallet').expect(200);
    return res.body.balance;
  }

  describe('withdrawal bank discovery and verification', () => {
    it('bank listing requires authentication', async () => {
      await ctx.raw.get('/wallet/banks').expect(401);
      const response = await ctx.http.get('/wallet/banks').expect(200);
      expect(response.body).toEqual([{ name: 'Test Bank', code: '044' }]);
    });
    it('account verification requires authentication and maps verified details', async () => {
      const body = { bankCode: '044', accountNumber: '0690000034' };
      await ctx.raw.post('/wallet/resolve-account').send(body).expect(401);
      const response = await ctx.http.post('/wallet/resolve-account').send(body).expect(200);
      expect(response.body).toEqual({ accountNumber: '0690000034', accountName: 'TEST USER' });
    });
    it('rejects invalid bank codes and account numbers', async () => {
      await ctx.http
        .post('/wallet/resolve-account')
        .send({ bankCode: 'ACCESS', accountNumber: '123' })
        .expect(400);
    });
  });

  describe('user-linked withdrawal accounts', () => {
    it('persists a verified account and deduplicates repeated saves for its owner', async () => {
      const body = { bankCode: '044', accountNumber: '0690000034' };
      const first = await ctx.http.post('/wallet/bank-accounts').send(body).expect(201);
      const second = await ctx.http.post('/wallet/bank-accounts').send(body).expect(201);
      expect(second.body.id).toBe(first.body.id);
      expect(
        await ctx.prisma.withdrawalBankAccount.findUnique({ where: { id: first.body.id } }),
      ).toMatchObject({ userId: SEED_USER_ID });
      const listed = await ctx.http.get('/wallet/bank-accounts').expect(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0]).toMatchObject({
        id: first.body.id,
        bankName: 'Test Bank',
        accountName: 'TEST USER',
      });
    });
    it('other users cannot list or remove an owner account', async () => {
      const saved = await ctx.http
        .post('/wallet/bank-accounts')
        .send({ bankCode: '044', accountNumber: '0690000034' })
        .expect(201);
      ctx.setPrincipal({ userId: SEED_OTHER_ID });
      expect((await ctx.http.get('/wallet/bank-accounts').expect(200)).body).toEqual([]);
      await ctx.http.delete(`/wallet/bank-accounts/${saved.body.id}`).expect(404);
      expect(await ctx.prisma.withdrawalBankAccount.count()).toBe(1);
    });
    it('withdraws to the authenticated owner saved account ID', async () => {
      const saved = await ctx.http
        .post('/wallet/bank-accounts')
        .send({ bankCode: '044', accountNumber: '0690000034' })
        .expect(201);
      await ctx.http
        .post('/wallet/withdrawals')
        .send({ bankAccountId: saved.body.id, amount: '100.00' })
        .expect(201);
      expect(stub.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ accountNumber: '0690000034', accountBank: '044' }),
      );
    });
  });

  describe('GET /wallet/deposit-account', () => {
    it('returns an authed-required virtual account and reuses it across calls', async () => {
      await ctx.raw.get('/wallet/deposit-account').expect(401);

      const first = await ctx.http.get('/wallet/deposit-account').expect(200);
      expect(first.body).toMatchObject({
        accountNumber: '0123456789',
        bankName: 'Wema Bank',
        currency: 'NGN',
        isPermanent: false,
      });
      expect(stub.createVirtualAccount).toHaveBeenCalledTimes(1);

      const second = await ctx.http.get('/wallet/deposit-account').expect(200);
      expect(second.body.accountNumber).toBe('0123456789');
      expect(stub.createVirtualAccount).toHaveBeenCalledTimes(1);
    });

    it('persists the VA for the current user keyed by txRef', async () => {
      await ctx.http.get('/wallet/deposit-account').expect(200);
      const va = await ctx.prisma.virtualAccount.findFirst({ where: { userId: SEED_USER_ID } });
      expect(va).toMatchObject({ accountNumber: '0123456789', currency: 'NGN', status: 'ACTIVE' });
      expect(va?.txRef).toMatch(/^bonde_va_/);
    });
  });

  describe('POST /wallet/withdrawals', () => {
    it('reserves the balance and initiates a transfer', async () => {
      const before = await walletBalance();

      const res = await ctx.http
        .post('/wallet/withdrawals')
        .send({ amount: '2000.00', accountNumber: '0123456789', bankCode: '035' })
        .expect(201);

      expect(res.body).toMatchObject({
        amount: '2000.00',
        currency: 'NGN',
        status: 'PENDING',
      });
      expect(await walletBalance()).toBe((Number(before) - 2000).toFixed(2).padStart(5, '0'));
      expect(stub.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          accountBank: '035',
          accountNumber: '0123456789',
          reference: expect.stringMatching(/^bonde_wd_/),
        }),
      );
    });

    it('409s while a withdrawal is already in flight', async () => {
      await ctx.http
        .post('/wallet/withdrawals')
        .send({ amount: '2000.00', accountNumber: '0123456789', bankCode: '035' })
        .expect(201);
      await ctx.http
        .post('/wallet/withdrawals')
        .send({ amount: '1000.00', accountNumber: '0123456789', bankCode: '035' })
        .expect(409);
    });

    it('400s when the wallet cannot cover the amount', async () => {
      await ctx.http
        .post('/wallet/withdrawals')
        .send({ amount: '9999999999.00', accountNumber: '0123456789', bankCode: '035' })
        .expect(400);
    });
  });

  describe('POST /flutterwave/webhook', () => {
    it('rejects a missing/wrong signature', async () => {
      await ctx.raw
        .post('/flutterwave/webhook')
        .set('Content-Type', 'application/json')
        .send(Buffer.from(JSON.stringify({ event: 'charge.completed', data: {} })))
        .expect(401);

      const raw = Buffer.from(JSON.stringify({ event: 'charge.completed', data: {} }));
      await ctx.raw
        .post('/flutterwave/webhook')
        .set('Content-Type', 'application/json')
        .set('flutterwave-signature', 'bad-signature')
        .send(raw)
        .expect(401);
    });

    it('credits the wallet for a charge.completed against a known VA (idempotent)', async () => {
      await ctx.http.get('/wallet/deposit-account').expect(200);
      const va = await ctx.prisma.virtualAccount.findFirst({ where: { userId: SEED_USER_ID } });
      const before = await walletBalance();

      await postWebhook('charge.completed', {
        id: 42,
        txRef: va!.txRef,
        flwRef: 'flw_42',
        amount: 1500,
        currency: 'NGN',
        status: 'successful',
      });

      expect(await walletBalance()).toBe((Number(before) + 1500).toFixed(2).padStart(5, '0'));

      const dupe = await ctx.raw
        .post('/flutterwave/webhook')
        .set('Content-Type', 'application/json')
        .set('verif-hash', webhookSecret())
        .send(
          JSON.stringify({
            event: 'charge.completed',
            data: { id: 42, txRef: va!.txRef, amount: 1500, currency: 'NGN', status: 'successful' },
          }),
        )
        .expect(200);
      expect(dupe.body).toEqual({ received: true });
      expect(await walletBalance()).toBe((Number(before) + 1500).toFixed(2).padStart(5, '0'));
    });

    it('ignores charge.completed events that reference an unknown VA', async () => {
      const before = await walletBalance();
      await postWebhook('charge.completed', {
        id: 99,
        txRef: 'bonde_va_unknown',
        amount: 1000,
        currency: 'NGN',
        status: 'successful',
      });
      expect(await walletBalance()).toBe(before);
    });

    it('marks a reserved withdrawal SUCCESS on transfer.disburse', async () => {
      await ctx.http
        .post('/wallet/withdrawals')
        .send({ amount: '2000.00', accountNumber: '0123456789', bankCode: '035' })
        .expect(201);
      const reserve = await ctx.prisma.providerEvent.findFirst({
        where: { eventType: 'withdraw.reserve' },
      });

      await postWebhook('transfer.disburse', {
        id: 555,
        reference: reserve!.reference,
        status: 'SUCCESSFUL',
        amount: 2000,
        currency: 'NGN',
      });

      const tx = await ctx.prisma.transaction.findFirst({
        where: { id: reserve!.transactionId! },
      });
      expect(tx?.status).toBe('SUCCESS');
    });

    it('refunds the reservation on transfer.reversal', async () => {
      const before = await walletBalance();
      await ctx.http
        .post('/wallet/withdrawals')
        .send({ amount: '2000.00', accountNumber: '0123456789', bankCode: '035' })
        .expect(201);
      const reserve = await ctx.prisma.providerEvent.findFirst({
        where: { eventType: 'withdraw.reserve' },
      });

      await postWebhook('transfer.reversal', {
        id: 666,
        reference: reserve!.reference,
        status: 'FAILED',
        amount: 2000,
        currency: 'NGN',
      });

      const tx = await ctx.prisma.transaction.findFirst({
        where: { id: reserve!.transactionId! },
      });
      expect(tx?.status).toBe('FAIL');
      expect(await walletBalance()).toBe(before);
    });

    it('acks unknown event types without side effects', async () => {
      const res = await ctx.raw
        .post('/flutterwave/webhook')
        .set('Content-Type', 'application/json')
        .set('verif-hash', webhookSecret())
        .send(JSON.stringify({ event: 'card_transaction', data: { id: 1 } }))
        .expect(200);
      expect(res.body).toEqual({ received: true });
    });
  });
});
