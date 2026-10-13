import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CardStatus, Prisma } from '@prisma/client';
import { decrypt, encrypt } from '../../common/crypto/aes-gcm.js';
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
  allowTopUp: true,
  notifyHalfSpent: true,
  notifyLowBalance: true,
  notifyBudgetReached: true,
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
    findFirstOrThrow: vi.fn(async () => CARD),
    create: vi.fn(async (args) => ({ ...CARD, ...args.data })),
    update: vi.fn(async (args) => ({ ...CARD, ...args.data })),
    updateMany: vi.fn(async (_args) => ({ count: 1 })),
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
    deleteMany: vi.fn(async () => ({ count: 1 })),
    upsert: vi.fn(async (args) => ({ ...args.create })),
    ...overrides.category,
  };
  const cardProvider = {
    findFirst: vi.fn(async () => ({ id: PROVIDER_ID, isActive: true })),
    upsert: vi.fn(async (args) => ({ ...args.create })),
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
    deleteMany: vi.fn(async () => ({ count: 1 })),
    ...overrides.merchant,
  };
  const transaction = {
    findMany: vi.fn(async () => [TRANSACTION_ROW]),
    count: vi.fn(async () => 1),
    ...overrides.transaction,
  };
  const prisma = {
    $transaction: vi.fn(
      async (
        ops: Array<Promise<unknown>> | ((tx: unknown) => Promise<unknown>),
      ): Promise<unknown> => (typeof ops === 'function' ? ops(prisma) : Promise.all(ops)),
    ),
    card,
    cardLock,
    cardCategory,
    cardProvider,
    cardHistory,
    cardMerchant,
    transaction,
  };
  const config = { get: vi.fn((key: string) => (key === 'nodeEnv' ? 'test' : ENC_KEY)) };
  const service = new CardsService(prisma as never, config as never);
  return {
    prisma,
    service,
    card,
    cardLock,
    cardCategory,
    cardProvider,
    cardHistory,
    cardMerchant,
    transaction,
    config,
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

describe('CardsService.updateRules', () => {
  function withRule(lockType: string, config = {}) {
    return makeService({
      lock: {
        findMany: vi.fn(async () => [
          { id: LOCK_ID, cardId: CARD_ID, lockType, config, isActive: true },
        ]),
      },
    } as never);
  }

  it('checks ownership before modifying anything', async () => {
    const { service, card, cardLock } = makeService({
      card: { findFirst: vi.fn(async () => null) },
    } as never);
    await expect(service.updateRules(USER_ID, CARD_ID, { nickname: 'Changed' })).rejects.toThrow(
      NotFoundException,
    );
    expect(cardLock.findMany).not.toHaveBeenCalled();
    expect(card.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to edit destroyed cards', async () => {
    const { service, card } = makeService({
      card: { findFirst: vi.fn(async () => ({ ...CARD, status: CardStatus.CANCELLED })) },
    } as never);
    await expect(service.updateRules(USER_ID, CARD_ID, { nickname: 'Changed' })).rejects.toThrow(
      BadRequestException,
    );
    expect(card.updateMany).not.toHaveBeenCalled();
  });

  it('saves the existing self-destruct rule, preserves counters, and records before/after limits', async () => {
    const { service, prisma, cardLock, cardHistory, card } = withRule('SELF_DESTRUCT', {
      usageLimit: 2,
      usageCount: 1,
    });
    await service.updateRules(USER_ID, CARD_ID, {
      nickname: 'Updated',
      maxSpendLimit: '100.00',
      lock: { id: LOCK_ID, config: { usageLimit: 5, usageCount: 0 } },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(cardLock.update).toHaveBeenCalledWith({
      where: { id: LOCK_ID },
      data: { config: { usageLimit: 5, usageCount: 1 } },
    });
    expect(card.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CARD_ID, userId: USER_ID, status: { not: 'CANCELLED' } },
        data: { nickname: 'Updated', maxSpendLimit: '100.00' },
      }),
    );
    expect(cardHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: 'rules.update',
          changes: expect.objectContaining({
            currency: 'NGN',
            before: expect.objectContaining({ maxSpendLimit: null }),
            after: expect.objectContaining({ maxSpendLimit: '100.00' }),
          }),
        }),
      }),
    );
  });

  it('rejects a rule that does not belong to the card', async () => {
    const { service, cardLock } = withRule('SELF_DESTRUCT');
    await expect(
      service.updateRules(USER_ID, CARD_ID, {
        maxSpendLimit: '100.00',
        lock: { id: randomId(), config: { usageLimit: 2 } },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(cardLock.update).not.toHaveBeenCalled();
  });

  for (const usageLimit of [0, -1, 1.5, '2']) {
    it(`rejects invalid usage limit ${usageLimit}`, async () => {
      const { service, card } = withRule('SELF_DESTRUCT');
      await expect(
        service.updateRules(USER_ID, CARD_ID, {
          maxSpendLimit: '100.00',
          lock: { id: LOCK_ID, config: { usageLimit } },
        }),
      ).rejects.toThrow(BadRequestException);
      expect(card.updateMany).not.toHaveBeenCalled();
    });
  }

  it('requires a maximum limit on restricted cards', async () => {
    const { service } = withRule('SELF_DESTRUCT');
    await expect(
      service.updateRules(USER_ID, CARD_ID, { lock: { id: LOCK_ID, config: { usageLimit: 2 } } }),
    ).rejects.toThrow(BadRequestException);
  });

  it('accepts a rule-only save without an empty card update', async () => {
    const { service, card } = withRule('SELF_DESTRUCT', { usageLimit: 2 });
    card.findFirst.mockResolvedValue({
      ...CARD,
      maxSpendLimit: new Prisma.Decimal('100.00'),
    } as never);
    await service.updateRules(USER_ID, CARD_ID, {
      lock: { id: LOCK_ID, config: { usageLimit: 3 } },
    });
    expect(card.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { updatedAt: expect.any(Date) } }),
    );
  });

  it('validates time order and budget consistency', async () => {
    const time = withRule('TIME');
    await expect(
      time.service.updateRules(USER_ID, CARD_ID, {
        maxSpendLimit: '100.00',
        lock: {
          id: LOCK_ID,
          config: { start: '2026-10-20T00:00:00Z', end: '2026-10-19T00:00:00Z' },
        },
      }),
    ).rejects.toThrow(BadRequestException);
    const budget = withRule('BUDGET');
    await expect(
      budget.service.updateRules(USER_ID, CARD_ID, {
        monthlyLimit: '100.00',
        lock: { id: LOCK_ID, config: { monthlyLimit: '50.00' } },
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('replaces merchant selections while retaining unchanged merchant records', async () => {
    const { service, cardMerchant } = withRule('MERCHANT');
    cardMerchant.findMany.mockResolvedValue([{ id: MERCHANT_ID, merchantName: 'Amazon' }] as never);
    await service.updateRules(USER_ID, CARD_ID, {
      maxSpendLimit: '100.00',
      merchants: [{ merchantName: 'Amazon' }, { merchantName: 'Netflix' }],
    });
    expect(cardMerchant.deleteMany).toHaveBeenCalledWith({
      where: { cardId: CARD_ID, merchantName: { notIn: ['Amazon', 'Netflix'] } },
    });
    expect(cardMerchant.create).toHaveBeenCalledTimes(1);
    expect(cardMerchant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cardId: CARD_ID, merchantName: 'Netflix' }),
      }),
    );
  });

  it('updates category allowlists without removing denied entries', async () => {
    const { service, cardCategory } = withRule('CATEGORY');
    await service.updateRules(USER_ID, CARD_ID, {
      maxSpendLimit: '100.00',
      categories: ['GROCERIES'],
    });
    expect(cardCategory.deleteMany).toHaveBeenCalledWith({
      where: { cardId: CARD_ID, isAllowed: true, category: { notIn: ['GROCERIES'] } },
    });
    expect(cardCategory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cardId_category: { cardId: CARD_ID, category: 'GROCERIES' } },
        update: { isAllowed: true },
      }),
    );
  });

  it('does not write history or card changes if a rule write fails', async () => {
    const { service, cardLock, card, cardHistory } = withRule('SELF_DESTRUCT');
    cardLock.update.mockRejectedValue(new Error('Database unavailable'));
    await expect(
      service.updateRules(USER_ID, CARD_ID, {
        maxSpendLimit: '100.00',
        lock: { id: LOCK_ID, config: { usageLimit: 2 } },
      }),
    ).rejects.toThrow('Database unavailable');
    expect(card.updateMany).not.toHaveBeenCalled();
    expect(cardHistory.create).not.toHaveBeenCalled();
  });

  function randomId() {
    return 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  }
});

describe('CardsService.get', () => {
  it('404s for a card the user does not own', async () => {
    const { service, card } = makeService();
    card.findFirst.mockResolvedValue(null);
    await expect(service.get(USER_ID, CARD_ID)).rejects.toThrow(NotFoundException);
  });
});

describe('CardsService.listLocks usage count', () => {
  it('counts settled card payments across the full history', async () => {
    const { service, cardLock, transaction } = makeService();
    cardLock.findMany.mockResolvedValue([
      {
        id: LOCK_ID,
        cardId: CARD_ID,
        lockType: 'SELF_DESTRUCT',
        config: { usageLimit: 5 },
        isActive: true,
      },
    ] as never);
    transaction.count.mockResolvedValue(2);
    const locks = await service.listLocks(USER_ID, CARD_ID);
    expect(locks[0].config).toEqual({ usageLimit: 5, usageCount: 2 });
    expect(transaction.count).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        cardId: CARD_ID,
        type: 'PAYMENT',
        status: 'SUCCESS',
        approvalStatus: 'APPROVED',
      },
    });
    expect(cardLock.update).not.toHaveBeenCalled();
  });

  it('uses a recorded counter when one exists', async () => {
    const { service, cardLock, transaction } = makeService();
    cardLock.findMany.mockResolvedValue([
      {
        id: LOCK_ID,
        cardId: CARD_ID,
        lockType: 'SELF_DESTRUCT',
        config: { usageLimit: 5, usageCount: 0 },
        isActive: true,
      },
    ] as never);
    const locks = await service.listLocks(USER_ID, CARD_ID);
    expect(locks[0].config).toEqual({ usageLimit: 5, usageCount: 0 });
    expect(transaction.count).not.toHaveBeenCalled();
  });

  it('does not count usage for unrelated lock types', async () => {
    const { service, cardLock, transaction } = makeService();
    cardLock.findMany.mockResolvedValue([
      { id: LOCK_ID, cardId: CARD_ID, lockType: 'MERCHANT', config: {}, isActive: true },
    ] as never);
    await service.listLocks(USER_ID, CARD_ID);
    expect(transaction.count).not.toHaveBeenCalled();
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
  it('stores an encrypted development CVV without exposing it in card responses', async () => {
    const { service, card, config } = makeService();
    config.get.mockImplementation((key) => (key === 'nodeEnv' ? 'development' : ENC_KEY));
    const result = await service.create(USER_ID, {});
    expect(decrypt(card.create.mock.calls[0][0].data.cardCvvEncrypted, ENC_KEY)).toMatch(/^\d{3}$/);
    expect(result).not.toHaveProperty('cardCvvEncrypted');
    expect(result).not.toHaveProperty('cvv');
  });
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
    expect(cardProvider.upsert).not.toHaveBeenCalled();
  });

  it('prefers an existing active provider in development', async () => {
    const { service, card, cardProvider, config } = makeService();
    config.get.mockImplementation((key) => (key === 'nodeEnv' ? 'development' : ENC_KEY));

    await service.create(USER_ID, {});

    expect(card.create.mock.calls[0][0].data.providerId).toBe(PROVIDER_ID);
    expect(cardProvider.upsert).not.toHaveBeenCalled();
  });

  it('creates an inactive fallback provider for local cards in development', async () => {
    const { service, card, cardProvider, config } = makeService();
    config.get.mockImplementation((key) => (key === 'nodeEnv' ? 'development' : ENC_KEY));
    cardProvider.findFirst.mockResolvedValue(null);

    await service.create(USER_ID, { nickname: 'Development card' });

    const fallback = cardProvider.upsert.mock.calls[0][0];
    expect(fallback).toEqual({
      where: { name: 'Bonde Development' },
      create: {
        id: expect.any(String),
        name: 'Bonde Development',
        baseUrl: 'http://localhost',
        isActive: false,
        config: { developmentOnly: true },
      },
      update: {},
    });
    expect(card.create.mock.calls[0][0].data.providerId).toBe(fallback.create.id);
  });

  it('reuses the development provider on subsequent creates', async () => {
    const { service, card, cardProvider, config } = makeService();
    config.get.mockImplementation((key) => (key === 'nodeEnv' ? 'development' : ENC_KEY));
    cardProvider.findFirst.mockResolvedValue(null);
    cardProvider.upsert.mockResolvedValue({ id: PROVIDER_ID, isActive: false } as never);

    await service.create(USER_ID, {});
    await service.create(USER_ID, {});

    expect(cardProvider.upsert).toHaveBeenCalledTimes(2);
    for (const [args] of card.create.mock.calls) {
      expect(args.data.providerId).toBe(PROVIDER_ID);
    }
  });

  it('keeps production creation blocked when no active provider exists', async () => {
    const { service, card, cardProvider, config } = makeService();
    config.get.mockImplementation((key) => (key === 'nodeEnv' ? 'production' : ENC_KEY));
    cardProvider.findFirst.mockResolvedValue(null);

    await expect(service.create(USER_ID, {})).rejects.toThrow(NotFoundException);
    expect(cardProvider.upsert).not.toHaveBeenCalled();
    expect(card.create).not.toHaveBeenCalled();
  });

  it('stores budget preferences, defaulting them on', async () => {
    const { service, card } = makeService();
    const result = await service.create(USER_ID, {
      monthlyLimit: '20000',
      allowTopUp: false,
      notifyLowBalance: false,
    });
    const data = card.create.mock.calls[0][0].data;
    expect(data.allowTopUp).toBe(false);
    expect(data.notifyHalfSpent).toBe(true);
    expect(data.notifyLowBalance).toBe(false);
    expect(data.notifyBudgetReached).toBe(true);
    expect(result.allowTopUp).toBe(false);
  });
});

describe('CardsService.credentials', () => {
  it('backfills a stored CVV only for older local development cards', async () => {
    const { service, card, config } = makeService();
    config.get.mockImplementation((key) => (key === 'nodeEnv' ? 'development' : ENC_KEY));
    card.findFirst.mockResolvedValue({
      ...CARD,
      issuer: 'bonde',
      cardNumberEncrypted: encrypt('4242424242424242', ENC_KEY),
      cardCvvEncrypted: null,
    } as never);
    const result = await service.credentials(USER_ID, CARD_ID);
    expect(result.cvv).toMatch(/^\d{3}$/);
    expect(card.updateMany).toHaveBeenCalledWith({
      where: { id: CARD_ID, userId: USER_ID, issuer: 'bonde', cardCvvEncrypted: null },
      data: { cardCvvEncrypted: expect.any(String) },
    });
    expect(decrypt(card.updateMany.mock.calls[0][0].data.cardCvvEncrypted, ENC_KEY)).toBe(
      result.cvv,
    );
  });

  it('reuses a development CVV written by a concurrent reader', async () => {
    const { service, card, config } = makeService();
    config.get.mockImplementation((key) => (key === 'nodeEnv' ? 'development' : ENC_KEY));
    const source = {
      ...CARD,
      issuer: 'bonde',
      cardNumberEncrypted: encrypt('4242424242424242', ENC_KEY),
    };
    card.findFirst
      .mockResolvedValueOnce({ ...source, cardCvvEncrypted: null } as never)
      .mockResolvedValueOnce({ ...source, cardCvvEncrypted: encrypt('456', ENC_KEY) } as never);
    card.updateMany.mockResolvedValue({ count: 0 });
    expect((await service.credentials(USER_ID, CARD_ID)).cvv).toBe('456');
  });

  it('does not invent a CVV for a provider-issued card', async () => {
    const { service, card, config } = makeService();
    config.get.mockImplementation((key) => (key === 'nodeEnv' ? 'development' : ENC_KEY));
    card.findFirst.mockResolvedValue({
      ...CARD,
      issuer: 'flutterwave',
      cardNumberEncrypted: encrypt('4242424242424242', ENC_KEY),
      cardCvvEncrypted: null,
    } as never);
    expect((await service.credentials(USER_ID, CARD_ID)).cvv).toBeNull();
    expect(card.updateMany).not.toHaveBeenCalled();
  });

  it('decrypts PAN and CVV only after checking card ownership', async () => {
    const { service, card } = makeService();
    card.findFirst.mockResolvedValue({
      ...CARD,
      cardNumberEncrypted: encrypt('4242424242424242', ENC_KEY),
      cardCvvEncrypted: encrypt('123', ENC_KEY),
    } as never);
    expect(await service.credentials(USER_ID, CARD_ID)).toEqual({
      cardNumber: '4242424242424242',
      cvv: '123',
    });
    expect(card.findFirst).toHaveBeenCalledWith({ where: { id: CARD_ID, userId: USER_ID } });
  });

  it('does not expose credentials for a missing or foreign card', async () => {
    const { service, card } = makeService();
    card.findFirst.mockResolvedValue(null);
    await expect(service.credentials(USER_ID, CARD_ID)).rejects.toThrow(NotFoundException);
  });

  it('returns null for a legacy card without a stored CVV', async () => {
    const { service, card } = makeService();
    card.findFirst.mockResolvedValue({
      ...CARD,
      cardNumberEncrypted: encrypt('4242424242424242', ENC_KEY),
      cardCvvEncrypted: null,
    } as never);
    expect(await service.credentials(USER_ID, CARD_ID)).toEqual({
      cardNumber: '4242424242424242',
      cvv: null,
    });
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

  it('updates budget preferences and records them in the diff', async () => {
    const { service, card } = makeService();
    await service.update(USER_ID, CARD_ID, {
      allowTopUp: false,
      notifyBudgetReached: false,
    });
    expect(card.update).toHaveBeenCalledWith({
      where: { id: CARD_ID },
      data: { allowTopUp: false, notifyBudgetReached: false },
    });
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
