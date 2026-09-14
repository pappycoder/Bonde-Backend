import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CardStatus, Prisma, TransactionType } from '@prisma/client';
import { IssuedCardsService } from './issued-cards.service.js';
import type { FlutterwaveCardsService } from '../flutterwave/flutterwave-cards.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WALLET_ID = '77777777-7777-4777-8777-777777777777';
const CARD_ID = '44444444-4444-4444-8444-444444444444';
const PROVIDER_ID = '33333333-3333-4333-8333-333333333333';

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: '7' });
}

const ISSUED = {
  id: CARD_ID,
  userId: USER_ID,
  providerId: PROVIDER_ID,
  cardNumberEncrypted: 'enc::pan',
  cardNumberLast4: '8381',
  cardType: 'virtual',
  issuer: 'flutterwave',
  currency: 'NGN',
  nameOnCard: 'AMINA SULE',
  status: CardStatus.ACTIVE,
  nickname: null,
  maxSpendLimit: null,
  monthlyLimit: null,
  totalSpent: '0.00',
  balance: '5000.00',
  expirationType: 'yearly',
  expirationDate: new Date('2029-12-31T23:59:59.999Z'),
  externalReferenceId: 'fw_card_1',
  lastSyncAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const profile = {
    findUnique: vi.fn(async () => ({
      id: USER_ID,
      fullName: 'Amina Sule',
      email: 'me@bonde.app',
    })),
    ...overrides.profile,
  };
  const wallet = {
    findFirst: vi.fn(async () => ({ id: WALLET_ID, balance: '5000.00' })),
    updateMany: vi.fn(async () => ({ count: 1 })),
    update: vi.fn(async (args) => ({ id: WALLET_ID, ...args.data })),
    ...overrides.wallet,
  };
  const cardProvider = {
    findFirst: vi.fn(async () => ({ id: PROVIDER_ID, isActive: true })),
    ...overrides.cardProvider,
  };
  const card = {
    findFirst: vi.fn(async () => ISSUED),
    create: vi.fn(async (args) => ({ ...ISSUED, ...args.data })),
    update: vi.fn(async (args) => ({ ...ISSUED, ...args.data })),
    ...overrides.card,
  };
  const transaction = {
    create: vi.fn(async (args) => ({ id: 'tx-1', ...args.data })),
    ...overrides.transaction,
  };
  const providerEvent = {
    create: vi.fn(async () => ({ id: 'event-1' })),
    update: vi.fn(async () => ({})),
    ...overrides.providerEvent,
  };
  const cardHistory = {
    create: vi.fn(async (args) => ({ id: 'h-1', ...args.data })),
    ...overrides.history,
  };
  const delegates = { providerEvent, card, transaction, wallet, cardHistory };
  const prisma = {
    profile,
    wallet,
    cardProvider,
    card,
    transaction,
    providerEvent,
    cardHistory,
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(delegates);
      return Promise.all(arg as Array<Promise<unknown>>);
    }),
  };
  const fwCards = {
    issueCard: vi.fn(async () => ({
      providerCardId: 'fw_card_1',
      cardNumberEncrypted: 'enc::pan',
      cardCvvEncrypted: 'enc::cvv',
      cardNumberLast4: '8381',
      nameOnCard: 'AMINA SULE',
      cardType: 'virtual',
      currency: 'NGN',
      balance: '5000.00',
      status: 'ACTIVE',
      expirationDate: new Date('2029-12-31T23:59:59.999Z'),
    })),
    fundCard: vi.fn(async () => ({ balance: '7500.00' })),
    withdrawFromCard: vi.fn(async () => ({ balance: '3000.00' })),
    terminateCard: vi.fn(async () => ({ balance: '0.00' })),
    blockCard: vi.fn(async () => undefined),
    unblockCard: vi.fn(async () => undefined),
    getCard: vi.fn(async () => ({ balance: '4000.00' })),
    listCardTransactions: vi.fn(async () => []),
    ...overrides.fwCards,
  };
  const activity = { record: vi.fn(async () => undefined) };
  const service = new IssuedCardsService(
    prisma as never,
    fwCards as unknown as FlutterwaveCardsService,
    activity as never,
  );
  return { service, prisma, fwCards, activity, card, transaction, wallet, providerEvent };
}

describe('IssuedCardsService.issue', () => {
  it('persists a card + prefund transfer and debits the wallet', async () => {
    const { service, prisma, transaction, wallet } = makeService();
    const result = await service.issue(USER_ID, { amount: '5000.00' });

    expect(result).toMatchObject({ issuer: 'flutterwave', cardNumberLast4: '8381' });
    expect(transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: TransactionType.TRANSFER }),
      }),
    );
    expect(wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { balance: { decrement: expect.any(Prisma.Decimal) } } }),
    );
    expect(prisma.providerEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PROCESSED' }),
      }),
    );
  });

  it('rolls back without persisting when the wallet cannot cover the prefund', async () => {
    const { service, wallet } = makeService();
    wallet.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.issue(USER_ID, { amount: '5000.00' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('fails the reservation event when the provider rejects issuance', async () => {
    const { service, prisma, fwCards } = makeService();
    fwCards.issueCard.mockRejectedValue(new Error('provider down'));
    await expect(service.issue(USER_ID, { amount: '5000.00' })).rejects.toBeDefined();
    expect(prisma.providerEvent.update).toHaveBeenCalled();
  });

  it('rejects issuance when the provider omits encrypted credentials', async () => {
    const { service, fwCards } = makeService();
    fwCards.issueCard.mockResolvedValue({
      providerCardId: 'fw_card_1',
      cardNumberLast4: '8381',
      currency: 'NGN',
      balance: '5000.00',
      status: 'ACTIVE',
      expirationDate: new Date(),
    });
    await expect(service.issue(USER_ID, { amount: '5000.00' })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('IssuedCardsService.fund', () => {
  it('guards the debit, calls the provider, and persists the new balance', async () => {
    const { service, wallet, fwCards, transaction } = makeService();
    const result = await service.fund(USER_ID, CARD_ID, '2500.00');

    expect(wallet.updateMany).toHaveBeenCalled();
    expect(fwCards.fundCard).toHaveBeenCalledWith({
      providerCardId: 'fw_card_1',
      amount: '2500.00',
    });
    expect(transaction.create).toHaveBeenCalled();
    expect(result.balance).toBe('7500.00');
  });

  it('rejects funding beyond the wallet balance', async () => {
    const { service, wallet, fwCards } = makeService();
    wallet.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.fund(USER_ID, CARD_ID, '2500.00')).rejects.toThrow(BadRequestException);
    expect(fwCards.fundCard).not.toHaveBeenCalled();
  });

  it('recredits the wallet when the provider fund call fails after the guard', async () => {
    const { service, wallet, fwCards } = makeService();
    fwCards.fundCard.mockRejectedValue(
      Object.assign(new Error('provider down'), { code: 'PROVIDER' }),
    );
    await expect(service.fund(USER_ID, CARD_ID, '2500.00')).rejects.toBeDefined();
    expect(wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { balance: { increment: expect.any(Prisma.Decimal) } } }),
    );
  });
});

describe('IssuedCardsService.withdraw', () => {
  it('withdraws provider-first then credits the wallet', async () => {
    const { service, wallet, fwCards, transaction } = makeService();
    const result = await service.withdraw(USER_ID, CARD_ID, '2000.00');

    expect(fwCards.withdrawFromCard).toHaveBeenCalledWith('fw_card_1', '2000.00');
    expect(wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { balance: { increment: expect.any(Prisma.Decimal) } } }),
    );
    expect(transaction.create).toHaveBeenCalled();
    expect(result.balance).toBe('3000.00');
  });

  it('rejects withdrawals beyond the cached card balance', async () => {
    const { service, card, fwCards } = makeService();
    card.findFirst.mockResolvedValue({ ...ISSUED, balance: '500.00' });
    await expect(service.withdraw(USER_ID, CARD_ID, '2000.00')).rejects.toThrow(
      BadRequestException,
    );
    expect(fwCards.withdrawFromCard).not.toHaveBeenCalled();
  });
});

describe('IssuedCardsService.cancel', () => {
  it('refuses to cancel a card with a funded balance', async () => {
    const { service, card, fwCards } = makeService();
    card.findFirst.mockResolvedValue({ ...ISSUED, balance: '500.00' });
    await expect(service.cancel(USER_ID, CARD_ID)).rejects.toThrow(BadRequestException);
    expect(fwCards.terminateCard).not.toHaveBeenCalled();
  });

  it('terminates a zero-balance card and marks it CANCELLED', async () => {
    const { service, card, fwCards } = makeService();
    card.findFirst.mockResolvedValue({ ...ISSUED, balance: '0.00' });
    const result = await service.cancel(USER_ID, CARD_ID);
    expect(fwCards.terminateCard).toHaveBeenCalledWith('fw_card_1');
    expect(result.status).toBe(CardStatus.CANCELLED);
  });
});

describe('IssuedCardsService.pause / resume', () => {
  it('blocks the provider card on pause and resumes on resume', async () => {
    const { service, fwCards, card } = makeService();
    await service.pause(USER_ID, CARD_ID);
    expect(fwCards.blockCard).toHaveBeenCalledWith('fw_card_1');
    expect(card.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: CardStatus.PAUSED } }),
    );

    await service.resume(USER_ID, CARD_ID);
    expect(fwCards.unblockCard).toHaveBeenCalledWith('fw_card_1');
    expect(card.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: CardStatus.ACTIVE } }),
    );
  });
});

describe('IssuedCardsService.syncTransactions', () => {
  it('records new spends, refreshes the balance, and is replay-safe', async () => {
    const { service, fwCards, providerEvent, transaction } = makeService();
    fwCards.listCardTransactions.mockResolvedValue([
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
    ]);

    const result = await service.syncTransactions(USER_ID, CARD_ID);

    expect(result.newSpends).toBe(2);
    expect(providerEvent.create).toHaveBeenCalledTimes(2);
    expect(transaction.create).toHaveBeenCalledTimes(2);
    expect(fwCards.getCard).toHaveBeenCalledWith('fw_card_1');
    expect(result.balance).toBe('4000.00');
  });

  it('skips transactions already observed via the provider event sink', async () => {
    const { service, fwCards, providerEvent, transaction } = makeService();
    fwCards.listCardTransactions.mockResolvedValue([
      { id: 1, amount: 1200, currency: 'NGN', status: 'successful', narration: 'Lunch' },
    ]);
    providerEvent.create.mockRejectedValue(prismaError('P2002'));

    const result = await service.syncTransactions(USER_ID, CARD_ID);

    expect(result.newSpends).toBe(0);
    expect(transaction.create).not.toHaveBeenCalled();
  });

  it('404s for cards not owned or not provider-issued', async () => {
    const { service, card } = makeService();
    card.findFirst.mockResolvedValue(null);
    await expect(service.syncTransactions(USER_ID, CARD_ID)).rejects.toThrow(NotFoundException);
  });
});
