import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, TransactionType } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { WalletInsightsService } from './wallet-insights.service.js';
function setup() {
  const prisma = {
    wallet: {
      findFirst: vi.fn(async () => ({
        id: 'wallet-a',
        currency: 'NGN',
        monthlyBudget: new Prisma.Decimal('5000.00'),
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    transaction: {
      aggregate: vi.fn(async () => ({ _sum: { amount: new Prisma.Decimal('1200.25') } })),
      groupBy: vi.fn(async () => [
        { cardId: 'card-a', _sum: { amount: new Prisma.Decimal('200.25') } },
      ]),
    },
    card: {
      findMany: vi.fn(async () => [
        {
          id: 'card-a',
          nickname: 'Project Alpha',
          cardNumberLast4: '4242',
          monthlyLimit: new Prisma.Decimal('400.00'),
          locks: [{ lockType: 'BUDGET' }],
        },
      ]),
    },
    $queryRaw: vi.fn(async (..._args: unknown[]) => [{ id: 'tx-a' }]),
  };
  return { prisma, service: new WalletInsightsService(prisma as never) };
}
describe('WalletInsightsService', () => {
  it('scopes monthly settled spending to the owner, wallet and currency', async () => {
    const { service, prisma } = setup();
    const result = await service.budget('user-a', new Date('2026-10-14T12:00:00Z'));
    expect(result).toMatchObject({
      monthlyBudget: '5000.00',
      spent: '1200.25',
      resetAt: '2026-11-01T00:00:00.000Z',
      daysRemaining: 18,
      allocations: [{ id: 'card-a', spent: '200.25', monthlyLimit: '400.00' }],
    });
    expect(prisma.transaction.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-a',
          walletId: 'wallet-a',
          currency: 'NGN',
          status: 'SUCCESS',
          approvalStatus: 'APPROVED',
          createdAt: {
            gte: new Date('2026-10-01T00:00:00Z'),
            lt: new Date('2026-11-01T00:00:00Z'),
          },
          type: {
            in: [TransactionType.PAYMENT, TransactionType.WITHDRAWAL, TransactionType.TRANSFER],
          },
        }),
      }),
    );
  });
  it('allocations include only owner cards with positive monthly limits in this currency', async () => {
    const { service, prisma } = setup();
    await service.budget('user-a');
    expect(prisma.card.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-a',
          currency: 'NGN',
          monthlyLimit: { gt: 0 },
        }),
      }),
    );
  });
  it('budget updates are owner scoped and leave wallet balance untouched', async () => {
    const { service, prisma } = setup();
    await service.updateBudget('user-a', '8000.25');
    expect(prisma.wallet.updateMany).toHaveBeenCalledWith({
      where: { account: { userId: 'user-a' } },
      data: { monthlyBudget: new Prisma.Decimal('8000.25') },
    });
  });
  it.each(['0.00', '-1', '10000000000000.00'])(
    'rejects invalid budget %s before writing',
    async (amount) => {
      const { service, prisma } = setup();
      await expect(service.updateBudget('user-a', amount)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.wallet.updateMany).not.toHaveBeenCalled();
    },
  );
  it('missing wallet prevents budget writes', async () => {
    const { service, prisma } = setup();
    prisma.wallet.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.updateBudget('user-a', '500.00')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('categorization atomically updates one JSON key using owner-filtered parameters', async () => {
    const { service, prisma } = setup();
    expect(await service.categorize('user-a', 'tx-a', 'GROCERIES')).toEqual({
      id: 'tx-a',
      category: 'GROCERIES',
    });
    const call = prisma.$queryRaw.mock.calls[0];
    expect(call.slice(1)).toEqual(['GROCERIES', 'tx-a', 'user-a']);
    expect((call[0] as TemplateStringsArray).join('?')).toContain('jsonb_set');
    expect(prisma.wallet.updateMany).not.toHaveBeenCalled();
  });
  it('cannot categorize an unowned transaction or a deposit', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.categorize('user-b', 'tx-a', 'TRAVEL')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
