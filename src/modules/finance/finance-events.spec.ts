import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { FinanceEvents } from './finance-events.service.js';
import { FinanceWorker } from './finance-worker.service.js';

const decimal = (value: string) => new Prisma.Decimal(value);

describe('provider event economic identity', () => {
  it('accepts later state changes while deduplicating an identical bank delivery', async () => {
    const upsert = vi.fn();
    const events = new FinanceEvents(
      { financeInbox: { upsert } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: () => ({ incomingFeeBearer: 'sender' }) } as never,
    );
    await events.receive('safe-haven', 'account.debit', 'transfer', {
      status: 'Completed',
      reversed: 'false',
    });
    await events.receive('safe-haven', 'account.debit', 'transfer', {
      status: 'Completed',
      reversed: 'true',
    });
    await events.receive('safe-haven', 'account.debit', 'transfer', {
      status: 'Completed',
      reversed: 'true',
    });
    const refs = upsert.mock.calls.map((call) => call[0].where.provider_reference.reference);
    expect(refs[0]).not.toBe(refs[1]);
    expect(refs[1]).toBe(refs[2]);
  });
  it('does not credit a transfer that does not match the queried provider record', async () => {
    const update = vi.fn(),
      post = vi.fn();
    const prisma = {
      financeInbox: {
        findMany: vi.fn(async () => [
          {
            id: 'inbox',
            provider: 'safe-haven',
            eventType: 'account.credit',
            payload: { id: 'claimed', sessionId: 'session' },
          },
        ]),
        update,
      },
    };
    const safe = {
      call: vi.fn(async () => ({
        _id: 'different',
        sessionId: 'session',
        amount: 100,
        status: 'Completed',
      })),
    };
    await new FinanceEvents(
      prisma as never,
      { post } as never,
      safe as never,
      {} as never,
      {} as never,
      { get: () => ({ incomingFeeBearer: 'sender' }) } as never,
    ).run();
    expect(post).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REVIEW' }) }),
    );
  });
  it('does not double-credit the same verified deposit through different deliveries', async () => {
    const post = vi.fn();
    const tx = {
      $queryRaw: vi.fn(),
      financeJournal: { findUnique: vi.fn(async () => ({ id: 'existing-journal' })) },
      financeInbox: { update: vi.fn() },
    };
    const customer = { userId: 'user', bankAccountId: 'account', bankAccountNumber: '1234567890' };
    const prisma = {
      financeInbox: {
        findMany: vi.fn(async () => [
          {
            id: 'inbox',
            provider: 'safe-haven',
            eventType: 'account.credit',
            payload: { id: 'transfer', sessionId: 'session' },
          },
        ]),
        update: vi.fn(),
      },
      financeCustomer: { findFirst: vi.fn(async () => customer) },
      $transaction: vi.fn(async (fn: (db: unknown) => unknown) => fn(tx)),
    };
    const safe = {
      call: vi.fn(async () => ({
        _id: 'transfer',
        sessionId: 'session',
        account: 'account',
        creditAccountNumber: '1234567890',
        amount: 100,
        status: 'Completed',
        type: 'Inwards',
      })),
    };
    await new FinanceEvents(
      prisma as never,
      { post } as never,
      safe as never,
      {} as never,
      {} as never,
      { get: () => ({ incomingFeeBearer: 'sender' }) } as never,
    ).run();
    expect(post).not.toHaveBeenCalled();
    expect(tx.financeInbox.update).toHaveBeenCalled();
  });
  it('quarantines an unmatched capture without guessing a user debit', async () => {
    const post = vi.fn();
    const prisma = {
      financeInbox: {
        findMany: vi.fn(async () => [
          {
            id: 'inbox',
            provider: 'sudo',
            eventType: 'transaction.created',
            payload: { id: 'capture' },
          },
        ]),
        update: vi.fn(),
      },
      card: { findFirst: vi.fn(async () => ({ id: 'card', userId: 'user', currency: 'NGN' })) },
    };
    const sudo = {
      call: vi.fn(async () => ({
        _id: 'capture',
        card: 'provider-card',
        currency: 'NGN',
        amount: -10,
        authorization: null,
      })),
    };
    await new FinanceEvents(
      prisma as never,
      { post } as never,
      {} as never,
      sudo as never,
      {} as never,
      { get: () => ({ incomingFeeBearer: 'sender' }) } as never,
    ).run();
    expect(post).not.toHaveBeenCalled();
    expect(prisma.financeInbox.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REVIEW' }) }),
    );
  });
});

describe('confirmed payout fee accounting', () => {
  async function settle(actual: string) {
    const op = {
      id: 'op',
      userId: 'user',
      kind: 'WITHDRAW',
      currency: 'NGN',
      amount: decimal('100'),
      fee: decimal('10'),
      request: { accountNumber: '1234567890', bankCode: 'bank' },
    };
    const post = vi.fn();
    const tx = {
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      financeOperation: {
        findUniqueOrThrow: vi.fn(async () => ({ status: 'PENDING' })),
        update: vi.fn(),
      },
      financeInbox: { upsert: vi.fn() },
      transaction: { updateMany: vi.fn() },
    };
    const prisma = { $transaction: vi.fn(async (fn: (db: unknown) => unknown) => fn(tx)) };
    const worker = new FinanceWorker(
      prisma as never,
      { post } as never,
      {} as never,
      {} as never,
      { get: () => ({ treasuryAccountNumber: 'treasury' }) } as never,
      {} as never,
    );
    await worker.settleWithdrawal(op as never, {
      paymentReference: 'op',
      amount: 100,
      debitAccountNumber: 'treasury',
      creditAccountNumber: '1234567890',
      destinationInstitutionCode: 'bank',
      status: 'Completed',
      fees: actual,
    });
    return { post, tx };
  }
  it('returns a lower fee to the customer and balances all postings', async () => {
    const { post } = await settle('5');
    const lines = post.mock.calls[0][3] as Array<{ key: string; amount: Prisma.Decimal }>;
    expect(lines.reduce((sum, line) => sum.add(line.amount), decimal('0')).isZero()).toBe(true);
    expect(lines.find((line) => line.key === 'wallet:user:NGN')?.amount.toFixed(2)).toBe('5.00');
  });
  it('records an excess provider fee as a business exception without an unapproved customer debit', async () => {
    const { post, tx } = await settle('15');
    const lines = post.mock.calls[0][3] as Array<{ key: string; amount: Prisma.Decimal }>;
    expect(lines.reduce((sum, line) => sum.add(line.amount), decimal('0')).isZero()).toBe(true);
    expect(lines.some((line) => line.key === 'wallet:user:NGN' && line.amount.lt(0))).toBe(false);
    expect(tx.financeInbox.upsert).toHaveBeenCalled();
  });
});
