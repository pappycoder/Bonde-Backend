import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CardStatus, Prisma } from '@prisma/client';
import { CardsService } from './cards.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CARD_ID = '44444444-4444-4444-8444-444444444444';
const LOCK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CATEGORY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const CARD = {
  id: CARD_ID,
  userId: USER_ID,
  providerId: '33333333-3333-4333-8333-333333333333',
  cardNumberEncrypted: 'enc::ciphertext',
  cardNumberLast4: '4242',
  cardType: 'virtual',
  status: CardStatus.ACTIVE,
  nickname: null,
  maxSpendLimit: null,
  monthlyLimit: null,
  expirationType: 'monthly',
  expirationDate: new Date('2030-01-01T00:00:00.000Z'),
  externalReferenceId: null,
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
  const prisma = {
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    card,
    cardLock,
    cardCategory,
  };
  const service = new CardsService(prisma as never);
  return { service, card, cardLock, cardCategory };
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
