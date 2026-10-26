import { expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { projectAllocationReturn } from './finance-projections.js';
it('shows returned closed-card funds as an internal wallet credit owned by the original customer', async () => {
  const tx = {
    wallet: { findFirstOrThrow: vi.fn(async () => ({ id: 'wallet' })) },
    transaction: { create: vi.fn(async () => undefined) },
  };
  await projectAllocationReturn(tx as never, {
    userId: 'owner',
    cardId: 'card',
    currency: 'NGN',
    amount: new Prisma.Decimal('25.50'),
    reference: 'close:operation',
    operationId: 'operation',
  });
  expect(tx.wallet.findFirstOrThrow).toHaveBeenCalledWith({
    where: { account: { userId: 'owner' } },
  });
  expect(tx.transaction.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      id: 'operation',
      userId: 'owner',
      amount: new Prisma.Decimal('25.50'),
      type: 'TRANSFER',
      metadata: expect.objectContaining({ live: true, kind: 'RETURN', direction: 'CREDIT' }),
    }),
  });
});
