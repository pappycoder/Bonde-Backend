import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CardStatus, Prisma } from '@prisma/client';
import { decrypt } from '../../common/crypto/aes-gcm.js';
import { luhnCheckDigit } from '../accounts/account-number.js';
import { CardsService } from './cards.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CARD_ID = '44444444-4444-4444-8444-444444444444';
const LOCK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CATEGORY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROVIDER_ID = '33333333-3333-4333-8333-333333333333';
const MERCHANT_ID = '99999999-9999-4999-8999-999999999999';
const TX_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ENC_KEY = 'a'.repeat(64);

const CARD = {
  id: CARD_ID,
  userId: USER_ID,
  providerId: '33333333-3333-4333-8333-333333333333',
  cardNumberEncrypted: 'enc::ciphertext',
  cardCvvEncrypted: null,
  cardNumberLast4: '4242',
  cardType: 'virtual',
  issuer: 'bonde',
  currency: 'NGN',
  status: CardStatus.ACTIVE,
  nickname: null,
  maxSpendLimit: null,
  monthlyLimit: null,
  totalSpent: 0,
  balance: 0,
  lastSyncAt: null,
  nameOnCard: null,
  expirationType: 'monthly',
  expirationDate: new Date('2030-01-01T00:00:00.000Z'),
  externalReferenceId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const TRANSACTION_ROW = {
  id: TX_ID,
  userId: USER_ID,
  walletId: '77777777-7777-4777-8777-777777777777',
  cardId: CARD_ID,
  chatId: null,
  type: 'PAYMENT',
  status: 'PENDING',
  approvalStatus: 'PENDING',
  amount: '2500.00',
  currency: 'NGN',
  description: 'Lunch',
  metadata: {},
  frequency: 'ONE_TIME',
  isRecurring: false,
  recurrenceEndDate: null,
  nextOccurrenceDate: null,
  thresholdWarning: false,
  approvalNotes: null,
  approvedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: '7' });
}

function makeService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const card = {
    findMany: vi.fn(async () => [CARD]),
    count: vi.fn(async () => 1),
    findFirst: vi.fn(async () => CARD),
    create: vi.fn(async (args) => ({ ...CARD, ...args.data })),
    update: vi.fn(async (args) => ({ ...CARD, ...args.data })),
    ...overrides.card,
  };
  const cardLock = {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => ({ id: LOCK_ID, cardId: CARD_ID })),
    create: vi.fn(async (args) => ({ id: LOCK_ID, cardId: CARD_ID, ...args.data })),
    update: vi.fn(async (args) => ({ id: LOCK_ID, cardId: CARD_ID, ...args.data })),
    delete: vi.fn(async () => ({ id: LOCK_ID })),
    ...overrides.lock,
  };
  const cardCategory = {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => ({ id: CATEGORY_ID, cardId: CARD_ID })),
    create: vi.fn(async (args) => ({ id: CATEGORY_ID, cardId: CARD_ID, ...args.data })),
    update: vi.fn(async (args) => ({ id: CATEGORY_ID, cardId: CARD_ID, ...args.data })),
    delete: vi.fn(async () => ({ id: CATEGORY_ID })),
    ...overrides.category,
  };
  const cardProvider = {
    findFirst: vi.fn(async () => ({ id: PROVIDER_ID, isActive: true })),
    ...overrides.provider,
  };
  const cardHistory = {
    create: vi.fn(async (args) => ({ id: 'history-id', cardId: CARD_ID, ...args.data })),
    findMany: vi.fn(async () => [{ id: 'history-id', cardId: CARD_ID, event: 'create' }]),
    ...overrides.history,
  };
  const cardMerchant = {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => null),
    create: vi.fn(async (args) => ({ id: MERCHANT_ID, cardId: CARD_ID, ...args.data })),
    delete: vi.fn(async () => ({ id: MERCHANT_ID })),
    ...overrides.merchant,
  };
  const transaction = {
    findMany: vi.fn(async () => [TRANSACTION_ROW]),
    count: vi.fn(async () => 1),
    ...overrides.transaction,
  };
  const prisma = {
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    card,
    cardLock,
    cardCategory,
    cardProvider,
    cardHistory,
    cardMerchant,
    transaction,
  };
  const config = { get: vi.fn(() => ENC_KEY) };
  const service = new CardsService(prisma as never, config as never);
  return {
    service,
    card,
    cardLock,
    cardCategory,
    cardProvider,
    cardHistory,
    cardMerchant,
    transaction,
  };
}

describe('CardsService.list', () => {
  it('returns a paged envelope scoped to the user', async () => {
    const { service, card } = makeService();
    const result = await service.list(USER_ID, { page: 1, pageSize: 20 });
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
    expect(card.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
  });
});

describe('CardsService.get', () => {
  it('404s for a card the user does not own', async () => {
    const { service, card } = makeService();
    card.findFirst.mockResolvedValue(null);
    await expect(service.get(USER_ID, CARD_ID)).rejects.toThrow(NotFoundException);
  });
});

describe('CardsService.pause', () => {
  it('pauses an active card', async () => {
    const { service, card } = makeService();
    const result = await service.pause(USER_ID, CARD_ID);
    expect(result.status).toBe(CardStatus.PAUSED);
    expect(card.update).toHaveBeenCalledWith({
      where: { id: CARD_ID },
      data: { status: CardStatus.PAUSED },
    });
  });

  it('rejects pausing a cancelled card', async () => {
    const { service, card } = makeService();
    card.findFirst.mockResolvedValue({ id: CARD_ID, status: CardStatus.CANCELLED });
    await expect(service.pause(USER_ID, CARD_ID)).rejects.toThrow(BadRequestException);
  });
});

describe('CardsService.resume', () => {
  it('resumes a paused card', async () => {
    const { service } = makeService();
    const result = await service.resume(USER_ID, CARD_ID);
    expect(result.status).toBe(CardStatus.ACTIVE);
  });
});

describe('CardsService.updateLimit', () => {
  it('requires at least one limit', async () => {
    const { service } = makeService();
    await expect(service.updateLimit(USER_ID, CARD_ID, {})).rejects.toThrow(BadRequestException);
  });

  it('updates the provided limits', async () => {
    const { service, card } = makeService();
    const result = await service.updateLimit(USER_ID, CARD_ID, { maxSpendLimit: '10000.00' });
    expect(result.maxSpendLimit).toBe('10000.00');
    expect(card.update).toHaveBeenCalledWith({
      where: { id: CARD_ID },
      data: { maxSpendLimit: '10000.00' },
    });
  });

  it('normalizes trimmed limits to 2dp strings', async () => {
    const { service, card } = makeService();
    card.findFirst.mockResolvedValue({ id: CARD_ID, status: CardStatus.ACTIVE });
    const result = await service.updateLimit(USER_ID, CARD_ID, { maxSpendLimit: '10000' });
    expect(result.maxSpendLimit).toBe('10000.00');
  });
});

describe('CardsService locks', () => {
  it('maps a duplicate lock to 409', async () => {
    const { service, cardLock } = makeService();
    cardLock.create.mockRejectedValue(prismaError('P2002'));
    await expect(service.createLock(USER_ID, CARD_ID, { lockType: 'MERCHANT' })).rejects.toThrow(
      ConflictException,
    );
  });

  it('deletes an owned lock and reports it', async () => {
    const { service, card } = makeService();
    card.findFirst.mockResolvedValue({ id: CARD_ID, status: CardStatus.ACTIVE });
    await expect(service.deleteLock(USER_ID, CARD_ID, LOCK_ID)).resolves.toEqual({
      deleted: true,
      id: LOCK_ID,
    });
  });
});

describe('CardsService categories', () => {
  it('maps a duplicate category to 409', async () => {
    const { service, cardCategory } = makeService();
    cardCategory.create.mockRejectedValue(prismaError('P2002'));
    await expect(
      service.createCategory(USER_ID, CARD_ID, { category: 'TRAVEL_HOTEL' }),
    ).rejects.toThrow(ConflictException);
  });

  it('deletes an owned category', async () => {
    const { service } = makeService();
    await expect(service.deleteCategory(USER_ID, CARD_ID, CATEGORY_ID)).resolves.toEqual({
      deleted: true,
      id: CATEGORY_ID,
    });
  });
});

describe('CardsService.create', () => {
  it('creates a virtual card with an encrypted Luhn PAN and never returns it', async () => {
    const { service, card, cardProvider, cardHistory } = makeService();
    const result = await service.create(USER_ID, { cardType: 'virtual' });

    expect(cardProvider.findFirst).toHaveBeenCalledWith({ where: { isActive: true } });
    const createArgs = card.create.mock.calls[0][0];
    expect(createArgs.data.cardType).toBe('virtual');
    expect(createArgs.data.cardNumberLast4).toMatch(/^\d{4}$/);
    expect(createArgs.data.cardNumberEncrypted).toMatch(/^enc::/);
    const pan = decrypt(createArgs.data.cardNumberEncrypted, ENC_KEY);
    expect(pan).toMatch(/^4\d{15}$/);
    expect(luhnCheckDigit(Array.from(pan.slice(0, -1), Number))).toBe(Number(pan.slice(-1)));
    expect(createArgs.data.cardNumberLast4).toBe(pan.slice(-4));

    expect(result).not.toHaveProperty('cardNumberEncrypted');
    expect(result.cardNumberLast4).toBe(pan.slice(-4));
    expect(result.totalSpent).toBe('0.00');
    expect(cardHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event: 'create' }) }),
    );
  });

  it('derives the expiration date from the type when not provided', async () => {
    const { service, card } = makeService();
    await service.create(USER_ID, { expirationType: 'yearly' });
    const created = card.create.mock.calls[0][0].data as { expirationDate: Date };
    const diffDays = (created.expirationDate.getTime() - Date.now()) / 86_400_000;
    expect(diffDays).toBeGreaterThan(364);
    expect(diffDays).toBeLessThanOrEqual(365.1);
  });

  it('404s when no active card provider exists', async () => {
    const { service, card, cardProvider } = makeService();
    cardProvider.findFirst.mockResolvedValue(null);
    await expect(service.create(USER_ID, {})).rejects.toThrow(NotFoundException);
    expect(card.create).not.toHaveBeenCalled();
  });
});

describe('CardsService.update', () => {
  it('requires at least one field', async () => {
    const { service } = makeService();
    await expect(service.update(USER_ID, CARD_ID, {})).rejects.toThrow(BadRequestException);
  });

  it('normalizes money and records a before/after diff', async () => {
    const { service, card, cardHistory } = makeService();
    const result = await service.update(USER_ID, CARD_ID, {
      nickname: '  Weekend   ',
      maxSpendLimit: '10000',
    });
    expect(result.nickname).toBe('Weekend');
    expect(result.maxSpendLimit).toBe('10000.00');
    expect(card.update).toHaveBeenCalledWith({
      where: { id: CARD_ID },
      data: { nickname: 'Weekend', maxSpendLimit: '10000.00' },
    });
    expect(cardHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: 'update',
          changes: expect.objectContaining({
            before: { nickname: null, maxSpendLimit: null },
            after: { nickname: 'Weekend', maxSpendLimit: '10000.00' },
          }),
        }),
      }),
    );
  });

  it('rejects updating a cancelled card', async () => {
    const { service, card } = makeService();
    card.findFirst.mockResolvedValue({ ...CARD, status: CardStatus.CANCELLED });
    await expect(service.update(USER_ID, CARD_ID, { nickname: 'Nope' })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('CardsService history', () => {
  it('lists the timeline for an owned card, newest first', async () => {
    const { service, cardHistory } = makeService();
    const result = await service.listHistory(USER_ID, CARD_ID);
    expect(result).toEqual([expect.objectContaining({ event: 'create' })]);
    expect(cardHistory.findMany).toHaveBeenCalledWith({
      where: { cardId: CARD_ID },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('404s a foreign card’s history', async () => {
    const { service, card, cardHistory } = makeService();
    card.findFirst.mockResolvedValue(null);
    await expect(service.listHistory(USER_ID, CARD_ID)).rejects.toThrow(NotFoundException);
    expect(cardHistory.findMany).not.toHaveBeenCalled();
  });
});

describe('CardsService.transactions', () => {
  it('returns the paged history of transactions made with the card', async () => {
    const { service, card, transaction } = makeService();
    const result = await service.listTransactions(USER_ID, CARD_ID, { page: 2, pageSize: 10 });
    expect(card.findFirst).toHaveBeenCalledWith({ where: { id: CARD_ID, userId: USER_ID } });
    expect(result).toMatchObject({ total: 1, page: 2, pageSize: 10, totalPages: 1 });
    expect(result.items[0]).toMatchObject({ id: TX_ID, amount: '2500.00', type: 'PAYMENT' });
    expect(transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID, cardId: CARD_ID },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('404s a foreign card’s transactions', async () => {
    const { service, card } = makeService();
    card.findFirst.mockResolvedValue(null);
    await expect(service.listTransactions(USER_ID, CARD_ID)).rejects.toThrow(NotFoundException);
  });
});

describe('CardsService merchants', () => {
  it('adds a merchant to the allowlist and records history', async () => {
    const { service, cardMerchant, cardHistory } = makeService();
    const result = await service.addMerchant(USER_ID, CARD_ID, {
      merchantName: 'Acme',
      merchantCode: 'M-1',
    });
    expect(result).toMatchObject({ merchantName: 'Acme', merchantCode: 'M-1' });
    expect(cardMerchant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cardId: CARD_ID }) }),
    );
    expect(cardHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event: 'merchant.add' }) }),
    );
  });

  it('409s a duplicate merchant by code', async () => {
    const { service, cardMerchant } = makeService();
    cardMerchant.create.mockRejectedValue(prismaError('P2002'));
    await expect(
      service.addMerchant(USER_ID, CARD_ID, { merchantName: 'Acme', merchantCode: 'M-1' }),
    ).rejects.toThrow(ConflictException);
  });

  it('409s a duplicate merchant by name when no code is given', async () => {
    const { service, cardMerchant } = makeService();
    cardMerchant.findFirst.mockResolvedValue({ id: MERCHANT_ID, cardId: CARD_ID });
    await expect(service.addMerchant(USER_ID, CARD_ID, { merchantName: 'acme' })).rejects.toThrow(
      ConflictException,
    );
  });

  it('404s removing a merchant that is not on the card', async () => {
    const { service, cardMerchant } = makeService();
    cardMerchant.findFirst.mockResolvedValue(null);
    await expect(service.removeMerchant(USER_ID, CARD_ID, MERCHANT_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('removes an owned merchant and records history', async () => {
    const { service, cardMerchant } = makeService();
    cardMerchant.findFirst.mockResolvedValue({
      id: MERCHANT_ID,
      cardId: CARD_ID,
      merchantName: 'Acme',
      merchantCode: null,
    });
    await expect(service.removeMerchant(USER_ID, CARD_ID, MERCHANT_ID)).resolves.toEqual({
      deleted: true,
      id: MERCHANT_ID,
    });
    expect(cardMerchant.delete).toHaveBeenCalledWith({ where: { id: MERCHANT_ID } });
  });
});
