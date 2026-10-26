import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { policyDecision, validateRules } from './card-policy.js';
import { FinanceAuthorizations } from './finance-authorizations.service.js';
import { FinanceCapabilities } from './finance-capabilities.service.js';
import { FinanceWorker } from './finance-worker.service.js';
import { amountOf, fingerprint, secretMatches } from './finance.types.js';
import { LedgerService } from './ledger.service.js';

const dec = (value: string) => new Prisma.Decimal(value);

describe('live money boundaries', () => {
  it('rejects imprecise, negative, non-finite and out-of-range input', () => {
    for (const value of ['1.001', '-1', 'NaN', 'Infinity', '1e3', '1000000000000', '0'])
      expect(() => amountOf(value)).toThrow();
    expect(amountOf('0', true).toFixed(2)).toBe('0.00');
    expect(amountOf('999999999999.99').toFixed(2)).toBe('999999999999.99');
  });
  it('binds proofs to nested content independently of object field order', () => {
    expect(fingerprint({ kind: 'ISSUE', rules: { start: 'a', end: 'b' } })).toBe(
      fingerprint({ rules: { end: 'b', start: 'a' }, kind: 'ISSUE' }),
    );
    expect(fingerprint({ amount: '1.00', currency: 'NGN' })).not.toBe(
      fingerprint({ amount: '1.00', currency: 'USD' }),
    );
    expect(secretMatches(undefined, '')).toBe(false);
    expect(secretMatches('token', 'token')).toBe(true);
    expect(secretMatches('token', 'different')).toBe(false);
  });
  it('does not enable USD from a flag or a price endpoint alone', () => {
    const config = {
      get: () => ({
        enabled: true,
        usdEnabled: true,
        ngnEnabled: true,
        environment: 'production',
        sudoBaseUrl: 'https://api.sandbox.sudo.cards',
      }),
    };
    const c = new FinanceCapabilities(config as never);
    expect(c.view().configured).toBe(false);
    expect(c.view().currencies.USD.enabled).toBe(false);
    expect(() => c.assertCurrency('USD')).toThrow();
  });
});

describe('card policy including pending reservations', () => {
  const request = { amount: dec('25'), merchantId: 'merchant-a', mcc: '5411' };
  const usage = { spent: dec('75'), uses: 1 };
  it('includes outstanding holds in budget and usage capacity', () => {
    expect(policyDecision({ monthlyLimit: '99.99' }, request, usage)).toBe('MONTHLY_LIMIT');
    expect(policyDecision({ monthlyLimit: '100' }, request, usage)).toBeNull();
    expect(policyDecision({ type: 'SELF_DESTRUCT', usageLimit: 1 }, request, usage)).toBe(
      'USAGE_LIMIT',
    );
  });
  it('uses exact merchant identity and scheme category codes', () => {
    expect(
      policyDecision({ type: 'MERCHANT', merchantIds: ['merchant-a'] }, request, usage),
    ).toBeNull();
    expect(policyDecision({ type: 'MERCHANT', merchantIds: ['merchant'] }, request, usage)).toBe(
      'MERCHANT_NOT_ALLOWED',
    );
    expect(
      policyDecision({ type: 'CATEGORY', categories: ['GROCERIES'] }, request, usage),
    ).toBeNull();
    expect(
      policyDecision(
        { type: 'CATEGORY', categories: ['GROCERIES'] },
        { ...request, mcc: 'unknown' },
        usage,
      ),
    ).toBe('CATEGORY_NOT_ALLOWED');
  });
  it('enforces UTC time boundaries and per-purchase caps', () => {
    const rule = {
      type: 'TIME' as const,
      start: '2026-10-26T10:00:00Z',
      end: '2026-10-26T11:00:00Z',
    };
    expect(policyDecision(rule, request, usage, new Date(rule.start))).toBeNull();
    expect(policyDecision(rule, request, usage, new Date(rule.end))).toBe('TIME_WINDOW');
    expect(policyDecision({ maxSpendLimit: '24.99' }, request, usage)).toBe(
      'PER_TRANSACTION_LIMIT',
    );
  });
  it('rejects unsupported or unenforceable rule configurations', () => {
    for (const rule of [
      { type: 'MERCHANT', merchantIds: [] },
      { type: 'SELF_DESTRUCT', usageLimit: 0 },
      { type: 'TIME', start: 'x', end: 'y' },
      { type: 'BUDGET' },
      { type: 'CATEGORY', categories: ['made-up'] },
      { bogus: true },
    ])
      expect(() => validateRules(rule)).toThrow();
  });
});

describe('ledger journals', () => {
  const lines = [
    { key: 'wallet:u:NGN', userId: 'u', kind: 'WALLET', currency: 'NGN', amount: dec('-10') },
    { key: 'card:c:NGN', userId: 'u', kind: 'CARD', currency: 'NGN', amount: dec('10') },
  ];
  function tx() {
    return {
      financeJournal: { create: vi.fn(async () => ({ id: 'j' })) },
      financeAccount: { upsert: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
      financeEntry: { create: vi.fn() },
    };
  }
  it('requires balance independently for each currency before any write', async () => {
    const db = tx();
    await expect(
      new LedgerService().post(db as never, 'r', 'transfer', [
        lines[0],
        { ...lines[1], currency: 'USD' },
      ]),
    ).rejects.toThrow('Unbalanced');
    expect(db.financeJournal.create).not.toHaveBeenCalled();
  });
  it('guards user debits so one allocation cannot spend another allocation', async () => {
    const db = tx();
    await new LedgerService().post(db as never, 'r', 'transfer', lines);
    expect(db.financeAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ key: 'wallet:u:NGN', balance: { gte: dec('10') } }),
      }),
    );
    expect(db.financeEntry.create).toHaveBeenCalledTimes(2);
  });
  it('rejects insufficient funds so the enclosing database transaction rolls back', async () => {
    const db = tx();
    db.financeAccount.updateMany.mockResolvedValue({ count: 0 });
    await expect(new LedgerService().post(db as never, 'r', 'transfer', lines)).rejects.toThrow(
      'Insufficient',
    );
  });
});

describe('authorization replay and failure decisions', () => {
  const raw = {
    _id: 'auth',
    pendingRequest: { currency: 'NGN', amount: 20 },
    merchant: { country: 'NG', merchantId: 'm', category: '5411', name: 'Shop' },
    card: { _id: 'provider-card' },
  };
  it('returns the persisted decision on replay without another hold', async () => {
    const tx = {
      $queryRaw: vi.fn(),
      card: { findFirst: vi.fn(async () => ({ id: 'c', userId: 'u' })) },
      financeAuthorization: {
        findUnique: vi.fn(async () => ({
          cardId: 'c',
          currency: 'NGN',
          merchantId: 'm',
          merchantIdentityId: 'identity',
          requestType: 'PURCHASE',
          amount: dec('20'),
          responseCode: '00',
        })),
      },
    };
    const prisma = { $transaction: vi.fn(async (fn: (db: unknown) => unknown) => fn(tx)) };
    const ledger = { post: vi.fn() };
    const auth = new FinanceAuthorizations(
      prisma as never,
      ledger as never,
      { assertCurrency: vi.fn() } as never,
      {} as never,
      { observe: vi.fn(async () => ({ id: 'identity' })) } as never,
      {} as never,
    );
    expect((await auth.authorize(raw)).data.responseCode).toBe('00');
    expect(ledger.post).not.toHaveBeenCalled();
    expect(
      (await auth.authorize({ ...raw, pendingRequest: { currency: 'NGN', amount: 21 } })).data
        .responseCode,
    ).toBe('05');
  });
  it('declines malformed inputs and database timeouts', async () => {
    const auth = new FinanceAuthorizations(
      {
        $transaction: vi.fn(async () => {
          throw new Error('timeout');
        }),
      } as never,
      {} as never,
      { assertCurrency: vi.fn() } as never,
      {} as never,
      { observe: vi.fn(async () => ({ id: 'identity' })) } as never,
      {} as never,
    );
    expect((await auth.authorize(raw)).data.responseCode).toBe('05');
    expect((await auth.authorize({})).data.responseCode).toBe('05');
  });
});

describe('worker crash recovery', () => {
  it('does not send a second provider request when an operation was already claimed', async () => {
    const prisma = { financeOperation: { updateMany: vi.fn(async () => ({ count: 0 })) } };
    const sudo = { call: vi.fn() },
      safe = { call: vi.fn() };
    const worker = new FinanceWorker(
      prisma as never,
      {} as never,
      sudo as never,
      safe as never,
      {} as never,
      {} as never,
    );
    await worker.process('already-running');
    expect(sudo.call).not.toHaveBeenCalled();
    expect(safe.call).not.toHaveBeenCalled();
  });
  it('keeps an uncertain operation reserved and does not issue a refund', async () => {
    const op = {
      id: 'o',
      kind: 'WITHDRAW',
      status: 'PROCESSING',
      request: { bankCode: 'bank', accountNumber: '1234567890', accountName: 'User' },
      amount: dec('10'),
      fee: dec('0'),
    };
    const prisma = {
      financeOperation: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => op),
      },
      $transaction: vi.fn(),
    };
    const safe = {
      resolve: vi.fn(async () => ({ sessionId: 'session', accountName: 'User' })),
      call: vi.fn(async () => {
        throw new Error('network timeout');
      }),
    };
    const worker = new FinanceWorker(
      prisma as never,
      {} as never,
      {} as never,
      safe as never,
      { get: () => ({ treasuryAccountNumber: 'treasury' }) } as never,
      {} as never,
    );
    await worker.process('o');
    expect(prisma.financeOperation.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { status: 'UNKNOWN', leaseUntil: null } }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MAIL_SENDER } from '../../common/mail/mail.types.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FinanceInstallation } from './finance-installation.service.js';
import {
  AdminFinanceController,
  FinanceController,
  FinanceWebhooksController,
} from './finance.controller.js';
import { FinanceModule } from './finance.module.js';

@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useValue: {
        get: (key: string) => (key === 'finance' ? { enabled: false } : key === 'push' ? {} : {}),
      },
    },
    { provide: PrismaService, useValue: {} },
    { provide: MAIL_SENDER, useValue: { send: vi.fn() } },
  ],
  exports: [ConfigService, PrismaService, MAIL_SENDER],
})
class FinanceTestDependencies {}

describe('financial module wiring and environment separation', () => {
  it('resolves every controller and provider without network access', async () => {
    const module = await Test.createTestingModule({
      imports: [FinanceTestDependencies, FinanceModule],
    }).compile();
    await module.init();
    expect(module.get(FinanceController)).toBeDefined();
    expect(module.get(FinanceWebhooksController)).toBeDefined();
    expect(module.get(AdminFinanceController)).toBeDefined();
    await module.close();
  });
  it('refuses to promote sandbox money by switching a configuration variable', async () => {
    const prisma = {
      financeInstallation: {
        createMany: vi.fn(),
        findUniqueOrThrow: vi.fn(async () => ({ environment: 'sandbox' })),
      },
    };
    const installation = new FinanceInstallation(
      prisma as never,
      { get: () => ({ enabled: true, environment: 'production' }) } as never,
    );
    await expect(installation.onModuleInit()).rejects.toThrow('separate database');
  });
});

describe('Settled card budget alerts', () => {
  it('reports only newly crossed configured thresholds using exact money', async () => {
    const { budgetAlertTitles } = await import('./card-policy.js');
    const card = {
      monthlyLimit: new Prisma.Decimal('100.00'),
      notifyHalfSpent: true,
      notifyLowBalance: true,
      notifyBudgetReached: true,
    };
    expect(
      budgetAlertTitles(card, new Prisma.Decimal('49.99'), new Prisma.Decimal('0.01')),
    ).toEqual(['Half your card budget is spent']);
    expect(
      budgetAlertTitles(card, new Prisma.Decimal('50.00'), new Prisma.Decimal('0.01')),
    ).toEqual([]);
    expect(
      budgetAlertTitles(card, new Prisma.Decimal('79.99'), new Prisma.Decimal('20.01')),
    ).toEqual(['20% of your card budget remains', 'Your card budget is reached']);
  });
});

describe('Issuance without an initial allocation', () => {
  it('allows issuing a card for its fee while requiring positive money movement amounts', async () => {
    const { FinanceService } = await import('./finance.service.js');
    const service = new FinanceService(
      {} as never,
      {} as never,
      { assertCurrency: () => undefined } as never,
      {} as never,
      { get: () => ({ ngnIssueFee: '2.50' }) } as never,
    );
    expect(() =>
      service.validate({ kind: 'ISSUE', currency: 'NGN', amount: '0.00', fee: '2.50' }),
    ).not.toThrow();
    expect(() =>
      service.validate({
        kind: 'ALLOCATE',
        currency: 'NGN',
        amount: '0.00',
        fee: '0.00',
        cardId: 'card',
      }),
    ).toThrow();
  });
});
