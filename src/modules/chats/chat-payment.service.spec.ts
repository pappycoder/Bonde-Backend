import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { ChatPaymentService } from './chat-payment.service.js';
const setup = () => {
  const item = {
    id: 'item',
    approvalId: 'approval',
    decision: 'APPROVED',
    amount: '25.00',
    currency: 'NGN',
    merchant: 'Shop',
  };
  const db = {
    chat: { findFirst: vi.fn(async () => ({ id: 'chat' })) },
    message: {
      findFirst: vi.fn(async () => ({ content: JSON.stringify({ version: 1, items: [item] }) })),
    },
    transactionApproval: {
      findFirst: vi.fn(async () => ({
        status: 'APPROVED',
        transaction: {
          id: 'proposal',
          type: 'PAYMENT',
          amount: new Prisma.Decimal(25),
          currency: 'NGN',
        },
      })),
    },
  };
  return { db, item, service: new ChatPaymentService(db as never) };
};
describe('Approved chat purchase handoff', () => {
  it('uses the owned approved proposal amount and merchant without claiming payment', async () => {
    const { service, db } = setup();
    expect(await service.instructions('owner', 'chat', 'message', 'item')).toMatchObject({
      method: 'MERCHANT_CHECKOUT',
      amount: '25.00',
      merchant: 'Shop',
    });
    expect(db.transactionApproval.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'approval', transaction: { userId: 'owner', chatId: 'chat' } },
      }),
    );
  });
  it('rejects an unapproved proposal', async () => {
    const { service, item } = setup();
    item.decision = 'PENDING';
    await expect(service.instructions('owner', 'chat', 'message', 'item')).rejects.toThrow(
      'Approve this purchase first',
    );
  });
  it('rejects a changed proposal quote', async () => {
    const { service, item } = setup();
    item.amount = '26.00';
    await expect(service.instructions('owner', 'chat', 'message', 'item')).rejects.toThrow(
      'quote has changed',
    );
  });
});
