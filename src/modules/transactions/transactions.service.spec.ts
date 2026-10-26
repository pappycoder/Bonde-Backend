import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalsService } from './approvals.service.js';
import { TransactionsService } from './transactions.service.js';
describe('Confirmed financial activity reads', () => {
  it('only lists the authenticated user live activity with exact amounts', async () => {
    const prisma = {
      transaction: {
        findMany: vi.fn(async () => [{ id: 'tx', amount: new Prisma.Decimal('12.34') }]),
        count: vi.fn(async () => 1),
      },
      $transaction: (calls: Promise<unknown>[]) => Promise.all(calls),
    };
    const service = new TransactionsService(prisma as never);
    expect((await service.list('owner')).items[0].amount).toBe('12.34');
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'owner',
          metadata: { path: ['live'], equals: true },
        }),
      }),
    );
  });
  it('rejects a foreign transaction', async () => {
    const service = new TransactionsService({
      transaction: { findFirst: async () => null },
    } as never);
    await expect(service.get('foreign', 'tx')).rejects.toBeInstanceOf(NotFoundException);
  });
});
describe('Card retry approval presentation', () => {
  const setup = (status: string, expiresAt?: Date) => {
    const prisma = {
      financeAuthorization: {
        findFirst: vi.fn(async (): Promise<unknown> => ({
          id: 'provider-auth',
          status,
          amount: new Prisma.Decimal('42.50'),
          currency: 'NGN',
          merchantName: 'Shop',
          approvalExpiresAt: expiresAt,
          card: { totalSpent: new Prisma.Decimal(0) },
        })),
      },
    };
    return { prisma, service: new ApprovalsService(prisma as never) };
  };
  it('maps a pending authorization without pretending it is a completed purchase', async () => {
    const { service, prisma } = setup('AWAITING_APPROVAL');
    const row = await service.get('owner', 'provider-auth');
    expect(row).toMatchObject({ status: 'PENDING', transaction: { amount: '42.50' } });
    expect(row.notes).toContain('does not complete');
    expect(prisma.financeAuthorization.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'provider-auth', userId: 'owner' } }),
    );
  });
  it('marks expired retry grants declined', async () => {
    expect(
      await setup('RETRY_APPROVED', new Date(0)).service.get('owner', 'provider-auth'),
    ).toMatchObject({ status: 'DECLINED' });
  });
  it('rejects foreign authorizations', async () => {
    const { service, prisma } = setup('AWAITING_APPROVAL');
    prisma.financeAuthorization.findFirst.mockResolvedValue(null);
    await expect(service.get('foreign', 'auth')).rejects.toBeInstanceOf(NotFoundException);
  });
});
