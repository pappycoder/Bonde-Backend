import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { CardsService } from './cards.service.js';
const setup = () => {
  const card = {
    id: 'c',
    currency: 'NGN',
    cardNumberEncrypted: 'secret-pan',
    cardCvvEncrypted: 'secret-cvv',
    balance: new Prisma.Decimal(999),
    totalSpent: new Prisma.Decimal(10),
    maxSpendLimit: null,
    monthlyLimit: null,
  };
  const prisma = {
    card: {
      findMany: vi.fn(async () => [card]),
      count: vi.fn(async () => 1),
      findFirst: vi.fn(async (): Promise<unknown> => card),
    },
    financeAccount: { findUnique: vi.fn(async () => ({ balance: new Prisma.Decimal('12.34') })) },
    transaction: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    $transaction: vi.fn(async (calls: Promise<unknown>[]) => Promise.all(calls)),
  };
  return { prisma, service: new CardsService(prisma as never, {} as never, {} as never) };
};
describe('Sudo card reads', () => {
  it('uses the ledger allocation and excludes encrypted credentials', async () => {
    const { service, prisma } = setup();
    const card = await service.get('owner', 'c');
    expect(card.balance).toBe('12.34');
    expect(card).not.toHaveProperty('cardNumberEncrypted');
    expect(card).not.toHaveProperty('cardCvvEncrypted');
    expect(prisma.card.findFirst).toHaveBeenCalledWith({
      where: { id: 'c', userId: 'owner', issuer: 'sudo' },
    });
  });
  it('excludes sample and former provider cards from lists', async () => {
    const { service, prisma } = setup();
    expect((await service.list('owner')).items[0].balance).toBe('12.34');
    expect(prisma.card.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ issuer: 'sudo', userId: 'owner' }),
      }),
    );
  });
  it('rejects foreign cards before reading allocations or activity', async () => {
    const { service, prisma } = setup();
    prisma.card.findFirst.mockResolvedValue(null);
    await expect(service.listTransactions('foreign', 'c')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.transaction.findMany).not.toHaveBeenCalled();
  });
});
