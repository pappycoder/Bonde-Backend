import { afterAll, afterEach, beforeEach, describe, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AppConfig } from '../src/config/configuration.js';
import { FinanceWorker } from '../src/modules/finance/finance-worker.service.js';
import { SafeHavenClient, SudoClient } from '../src/modules/finance/providers.js';
import { PasscodeService } from '../src/modules/passcode/passcode.service.js';
import { SEED_USER_ID, seedBaseFixtures, truncateAll, type BootedE2EApp } from './e2e-app.js';
import { bootFinanceE2EApp, financeTestEnvironment } from './finance-fixtures.js';

const restore = financeTestEnvironment(6);
afterAll(restore);
const treasury = '9999999999',
  depositNumber = '1111111111',
  recipient = '2222222222';

describe('verified bank deposit through card purchases and bank withdrawal', () => {
  let ctx: BootedE2EApp;
  let config: AppConfig['finance'];
  let transfers: Map<string, Record<string, unknown>>;
  let transactions: Map<string, Record<string, unknown>>;
  let cards: Map<string, Record<string, unknown>>;
  let authorizationRecords: Map<string, Record<string, unknown>>;
  let transferPosts: number;
  let lostResponse: boolean;
  let payoutPending: boolean;
  let badSweep: boolean;
  const safe = {
    resolve: async () => ({ sessionId: 'enquiry', accountName: 'Recipient' }),
    call: async (
      path: string,
      method = 'GET',
      body?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (path === '/transfers/tqs') {
        const data = transfers.get(String(body?.sessionId));
        if (!data) throw new Error('Unknown transfer');
        return data;
      }
      if (path === '/transfers' && method === 'POST') {
        transferPosts++;
        const id = String(body!.paymentReference),
          isPayout = body!.debitAccountNumber === treasury;
        const result = {
          _id: `transfer-${id}`,
          sessionId: `session-${id}`,
          paymentReference: id,
          amount: body!.amount,
          debitAccountNumber: body!.debitAccountNumber,
          creditAccountNumber: !isPayout && badSweep ? recipient : body!.beneficiaryAccountNumber,
          destinationInstitutionCode: body!.beneficiaryBankCode,
          status: isPayout && payoutPending ? 'Pending' : 'Completed',
          fees: isPayout ? 7 : 0,
        };
        transfers.set(result.sessionId, result);
        if (isPayout && lostResponse) {
          lostResponse = false;
          throw new Error('Response lost after transfer');
        }
        return result;
      }
      if (path.startsWith('/accounts?'))
        return [{ _id: 'treasury-id', accountNumber: treasury, availableBalance: 10000 }];
      if (path.startsWith('/transfers?')) return [...transfers.values()];
      throw new Error(`Unexpected Safe Haven request ${path}`);
    },
  };
  const sudo = {
    call: async (
      path: string,
      method = 'GET',
      body?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (path.startsWith('/fundingsources/'))
        return {
          type: 'gateway',
          status: 'active',
          jitGateway: {
            authorizeByDefault: false,
            url: `${ctx.app.get<ConfigService<AppConfig, true>>(ConfigService).get('publicUrl')}/api/finance/webhooks/sudo`,
          },
        };
      if (path === '/cards' && method === 'POST') {
        const id = `provider-card-${cards.size + 1}`;
        const card = {
          ...body,
          _id: id,
          maskedPan: '************1234',
          expiryYear: 2030,
          expiryMonth: 12,
        };
        cards.set(id, card);
        return card;
      }
      if (path.startsWith('/cards/')) {
        const card = cards.get(path.slice('/cards/'.length));
        if (!card) throw new Error('Unknown card');
        if (method === 'PUT') Object.assign(card, body);
        return card;
      }
      if (path.startsWith('/transactions/'))
        return transactions.get(path.slice('/transactions/'.length));
      if (path.startsWith('/authorizations/'))
        return authorizationRecords.get(path.slice('/authorizations/'.length));
      if (path.includes('/balance')) return { availableBalance: 10000 };
      throw new Error(`Unexpected Sudo request ${path}`);
    },
  };
  beforeEach(async () => {
    transfers = new Map();
    transactions = new Map();
    cards = new Map();
    authorizationRecords = new Map();
    transferPosts = 0;
    lostResponse = false;
    payoutPending = false;
    badSweep = false;
    ctx = await bootFinanceE2EApp({
      overrides: [
        { token: SafeHavenClient, useValue: safe },
        { token: SudoClient, useValue: sudo },
      ],
    });
    config = ctx.app.get<ConfigService<AppConfig, true>>(ConfigService).get('finance');
    Object.assign(config, {
      environment: 'sandbox',
      sudoBusinessId: 'test-business',
      sudoWebhookToken: 'test-sudo',
      safeHavenWebhookToken: 'test-bank',
      jobToken: 'test-jobs',
      treasuryAccountNumber: treasury,
      safeHavenBankCode: 'bank',
      incomingFeeBearer: 'sender',
      withdrawalFee: '10.00',
      ngnBrand: 'Verve',
      ngnCardProgrammes: ['Verve', 'MasterCard', 'Visa'].map((brand) => ({
        brand,
        issueFee: '5.00',
        fundingSourceId: `source-${brand}`,
        settlementId: `settlement-${brand}`,
      })),
    });
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
    await ctx.app.get(PasscodeService).create(SEED_USER_ID, '1234');
    await ctx.prisma.profile.update({ where: { id: SEED_USER_ID }, data: { cardPlan: 'PREMIUM' } });
    await ctx.prisma.transactionThreshold.updateMany({ data: { isActive: false } });
    await ctx.prisma.financeCustomer.create({
      data: {
        userId: SEED_USER_ID,
        status: 'READY',
        sudoStatus: 'READY',
        bankStatus: 'READY',
        sudoId: 'customer',
        bankAccountId: 'deposit-id',
        bankAccountNumber: depositNumber,
      },
    });
  });
  afterEach(async () => {
    await ctx.close();
  });

  async function jobs() {
    return ctx.raw.post('/finance/jobs').set('Authorization', 'Bearer test-jobs').expect(200);
  }
  async function bankEvent(data: Record<string, unknown>, type: string) {
    await ctx.raw
      .post('/finance/webhooks/safe-haven')
      .set('Authorization', 'test-bank')
      .send({ eventType: type, data })
      .expect(200);
  }
  async function sudoEvent(
    type: string,
    data: Record<string, unknown>,
    delivery = String(data._id),
  ) {
    return ctx.raw
      .post('/finance/webhooks/sudo')
      .set('Authorization', 'test-sudo')
      .send({
        _id: delivery,
        business: 'test-business',
        environment: 'sandbox',
        type,
        data: { object: data },
      })
      .expect(200);
  }
  async function deposit(amount = 1000, id = 'deposit') {
    const data = {
      _id: id,
      sessionId: `session-${id}`,
      account: 'deposit-id',
      creditAccountNumber: depositNumber,
      amount,
      status: 'Completed',
      type: 'Inwards',
      fees: 0,
    };
    transfers.set(data.sessionId, data);
    await bankEvent(data, 'account.credit');
    await jobs();
    return data;
  }
  async function command(fields: Record<string, unknown>) {
    const body = { currency: 'NGN', amount: '0.00', fee: '0.00', ...fields };
    const proof = await ctx.http
      .post('/finance/proof')
      .send({ command: body, passcode: '1234' })
      .expect(201);
    return ctx.http
      .post('/finance/operations')
      .set('Idempotency-Key', `test-${crypto.randomUUID()}`)
      .send({ command: body, proof: proof.body.proof });
  }
  async function issue(brand = 'Verve') {
    const result = await command({ kind: 'ISSUE', brand, fee: '5.00' });
    expect(result.status).toBe(201);
    expect(result.body.status).toBe('SUCCEEDED');
    return result.body.cardId as string;
  }
  async function fund(cardId: string, amount = '400.00') {
    expect((await command({ kind: 'ALLOCATE', cardId, amount })).body.status).toBe('SUCCEEDED');
  }
  async function balances(cardId?: string) {
    const w = (await ctx.http.get('/wallet').expect(200)).body;
    const c = cardId ? (await ctx.http.get(`/cards/${cardId}`).expect(200)).body : null;
    return { wallet: w.balance, card: c?.balance, held: w.held };
  }
  async function authorize(cardId: string, amount = 120, id = 'authorization') {
    const card = await ctx.prisma.card.findUniqueOrThrow({ where: { id: cardId } });
    const data = {
      _id: id,
      pendingRequest: { currency: 'NGN', amount, merchantAmount: amount },
      card: { _id: card.externalReferenceId },
      merchant: { merchantId: 'merchant', category: '5411', name: 'Shop', country: 'NG' },
    };
    authorizationRecords.set(id, { ...data, status: 'declined' });
    return (await sudoEvent('authorization.request', data)).body.data.responseCode;
  }
  async function cardTransaction(
    cardId: string,
    id: string,
    amount: number,
    type = 'transaction.created',
    auth = 'authorization',
    fee = 0,
  ) {
    const card = await ctx.prisma.card.findUniqueOrThrow({ where: { id: cardId } });
    const data = {
      _id: id,
      card: card.externalReferenceId,
      authorization: auth,
      currency: 'NGN',
      amount,
      fee,
    };
    transactions.set(id, data);
    await sudoEvent(type, data);
    await jobs();
  }
  async function withdraw(amount = '200.00') {
    return command({
      kind: 'WITHDRAW',
      amount,
      fee: '10.00',
      bankCode: 'bank',
      accountNumber: recipient,
      accountName: 'Recipient',
    });
  }
  async function assertBalanced() {
    const rows = await ctx.prisma.$queryRaw<Array<{ total: Prisma.Decimal }>>`
      SELECT SUM(e.amount) AS total FROM finance_entries e JOIN finance_accounts a ON a.key=e.account_key
      GROUP BY e.journal_id, a.currency HAVING SUM(e.amount)<>0`;
    expect(rows).toEqual([]);
    expect(
      await ctx.prisma.financeAccount.count({
        where: { userId: SEED_USER_ID, balance: { lt: 0 } },
      }),
    ).toBe(0);
  }

  it.each(['Verve', 'MasterCard', 'Visa'])(
    'runs the complete flow for %s without double-debiting the wallet',
    async (brand) => {
      const incoming = await deposit();
      await bankEvent(incoming, 'account.credit');
      await jobs();
      expect((await balances()).wallet).toBe('1000.00');
      expect(
        await ctx.prisma.financeJournal.count({ where: { reference: 'deposit:deposit' } }),
      ).toBe(1);
      const card = await issue(brand);
      await fund(card);
      expect(await balances(card)).toMatchObject({ wallet: '595.00', card: '400.00' });
      expect(await authorize(card)).toBe('00');
      expect(await balances(card)).toMatchObject({
        wallet: '595.00',
        card: '280.00',
        held: '120.00',
      });
      await cardTransaction(card, 'capture', -118, 'transaction.created', 'authorization', 2);
      await sudoEvent('transaction.created', { _id: 'capture' }, 'redelivery');
      await jobs();
      expect(await balances(card)).toMatchObject({
        wallet: '595.00',
        card: '280.00',
        held: '0.00',
      });
      await cardTransaction(card, 'refund', 30, 'transaction.refund');
      await sudoEvent('transaction.refund', { _id: 'refund' }, 'refund-redelivery');
      await jobs();
      expect((await balances(card)).card).toBe('310.00');
      expect((await command({ kind: 'RETURN', cardId: card, amount: '100.00' })).body.status).toBe(
        'SUCCEEDED',
      );
      const payout = await withdraw();
      expect(payout.body.status).toBe('SUCCEEDED');
      expect(await balances(card)).toMatchObject({
        wallet: '488.00',
        card: '210.00',
        held: '0.00',
      });
      expect(
        await ctx.prisma.notification.count({ where: { title: 'Withdrawal completed' } }),
      ).toBe(1);
      await assertBalanced();
    },
  );
  it('recovers a lost bank transfer response without posting a second transfer', async () => {
    await deposit();
    await jobs(); // Finish the deposit sweep before counting payout POSTs.
    const before = transferPosts;
    lostResponse = true;
    const result = await withdraw();
    expect(result.body.status).toBe('UNKNOWN');
    expect((await balances()).wallet).toBe('790.00');
    await jobs();
    await jobs();
    expect((await ctx.http.get(`/finance/operations/${result.body.id}`)).body.status).toBe(
      'SUCCEEDED',
    );
    expect((await balances()).wallet).toBe('793.00');
    expect(transferPosts - before).toBe(1);
    await assertBalanced();
  });
  it('reconciles a reversed pending payout even when its callback is missing', async () => {
    await deposit();
    payoutPending = true;
    const result = await withdraw();
    expect(result.body.status).toBe('PENDING');
    const transfer = transfers.get(`session-${result.body.id}`)!;
    Object.assign(transfer, { status: 'Completed', isReversed: true });
    await jobs();
    await bankEvent(transfer, 'account.debit');
    await jobs();
    expect((await ctx.http.get(`/finance/operations/${result.body.id}`)).body.status).toBe(
      'REVERSED',
    );
    expect((await balances()).wallet).toBe('993.00');
    expect(
      await ctx.prisma.financeJournal.count({
        where: { reference: `payout-reversal:${result.body.id}` },
      }),
    ).toBe(1);
    expect(await ctx.prisma.notification.count({ where: { title: 'Withdrawal reversed' } })).toBe(
      1,
    );
    await assertBalanced();
  });
  it('handles a later payout reversal once and preserves its confirmed fee', async () => {
    await deposit();
    const result = await withdraw();
    const transfer = transfers.get(`session-${result.body.id}`)!;
    transfer.isReversed = true;
    await bankEvent(transfer, 'account.debit');
    await jobs();
    await bankEvent(transfer, 'account.debit');
    await jobs();
    expect((await balances()).wallet).toBe('993.00');
    expect(
      (await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: result.body.id } })).status,
    ).toBe('FAIL');
    await assertBalanced();
  });
  it('returns a failed pending payout reservation including the quoted fee', async () => {
    await deposit();
    payoutPending = true;
    const result = await withdraw();
    Object.assign(transfers.get(`session-${result.body.id}`)!, { status: 'Failed' });
    await jobs();
    await jobs();
    expect((await balances()).wallet).toBe('1000.00');
    expect(await ctx.prisma.notification.count({ where: { title: 'Withdrawal failed' } })).toBe(1);
    await assertBalanced();
  });
  it('does not mark a sweep successful when the provider confirms a different destination', async () => {
    badSweep = true;
    await deposit();
    await jobs();
    const sweep = await ctx.prisma.financeOperation.findFirstOrThrow({ where: { kind: 'SWEEP' } });
    expect(sweep.status).not.toBe('SUCCEEDED');
    expect((await balances()).wallet).toBe('1000.00');
    expect(await ctx.prisma.financeJournal.count({ where: { reference: 'deposit:deposit' } })).toBe(
      1,
    );
    await assertBalanced();
  });
  it.each(['authorization.declined', 'transaction.refund'])(
    'releases %s holds to the wallet after retirement',
    async (type) => {
      await deposit();
      const card = await issue();
      await fund(card);
      expect(await authorize(card)).toBe('00');
      await ctx.prisma.card.update({
        where: { id: card },
        data: {
          retiredAt: new Date(),
          retirementStatus: 'RETIRING',
          retirementReason: 'USER_RETIRED',
        },
      });
      if (type === 'authorization.declined') {
        await sudoEvent(type, { _id: 'authorization' });
        await ctx.app.get(FinanceWorker).run();
        // Run inbox directly so the retirement worker cannot consume the scenario first.
        const { FinanceEvents } = await import('../src/modules/finance/finance-events.service.js');
        await ctx.app.get(FinanceEvents).run();
      } else await cardTransaction(card, 'reversal', 120, type);
      expect((await balances(card)).held).toBe('0.00');
      const wallet = new Prisma.Decimal((await balances()).wallet);
      expect(wallet.gte(715)).toBe(true); // Released 120 is immediately spendable in the wallet.
      expect(wallet.add((await balances(card)).card).toFixed(2)).toBe('995.00');
      await assertBalanced();
    },
  );
  it('preserves an accepted payout source after treasury configuration changes', async () => {
    await deposit();
    payoutPending = true;
    const result = await withdraw();
    config.treasuryAccountNumber = '3333333333';
    Object.assign(transfers.get(`session-${result.body.id}`)!, { status: 'Completed' });
    await jobs();
    expect((await ctx.http.get(`/finance/operations/${result.body.id}`)).body.status).toBe(
      'SUCCEEDED',
    );
    expect((await balances()).wallet).toBe('793.00');
    await assertBalanced();
  });
  it('returns a cancelled card to its original settlement after its programme is removed', async () => {
    await deposit();
    const card = await issue('MasterCard');
    await fund(card);
    config.ngnCardProgrammes = config.ngnCardProgrammes!.filter((p) => p.brand === 'Verve');
    const result = await command({ kind: 'CANCEL', cardId: card, cancellationReason: 'lost' });
    expect(result.body.status).toBe('SUCCEEDED');
    expect([...cards.values()][0].creditAccountId).toBe('settlement-MasterCard');
    expect(await balances(card)).toMatchObject({ wallet: '995.00', card: '0.00', held: '0.00' });
    await assertBalanced();
  });
  it('serializes competing allocations so the wallet cannot be spent twice', async () => {
    await deposit();
    const card = await issue();
    const results = await Promise.all([
      command({ kind: 'ALLOCATE', cardId: card, amount: '600.00' }),
      command({ kind: 'ALLOCATE', cardId: card, amount: '600.00' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(await balances(card)).toMatchObject({ wallet: '395.00', card: '600.00' });
    await assertBalanced();
  });
  it('keeps allocations isolated between different cards and brands', async () => {
    await deposit();
    const mastercard = await issue('MasterCard'),
      visa = await issue('Visa');
    await fund(mastercard, '100.00');
    await fund(visa, '200.00');
    expect(await authorize(mastercard, 150, 'too-large')).toBe('51');
    expect(await authorize(mastercard, 80, 'within-allocation')).toBe('00');
    expect(await balances(mastercard)).toMatchObject({
      wallet: '690.00',
      card: '20.00',
      held: '80.00',
    });
    expect((await balances(visa)).card).toBe('200.00');
    await assertBalanced();
  });

  it('rejects spending and card returns exceeding available funds', async () => {
    await deposit();
    const card = await issue();
    await fund(card, '100.00');
    expect(await authorize(card, 101)).toBe('51');
    expect((await command({ kind: 'RETURN', cardId: card, amount: '101.00' })).status).toBe(400);
    expect(await balances(card)).toMatchObject({ wallet: '895.00', card: '100.00', held: '0.00' });
    await assertBalanced();
  });
});
