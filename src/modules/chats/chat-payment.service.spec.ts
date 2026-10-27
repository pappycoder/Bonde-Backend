import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { ChatProductDto } from './chat-replies.dto.js';
import { ChatPaymentService } from './chat-payment.service.js';
const setup = () => {
  const item: ChatProductDto = {
    title: 'Item',
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
  const delivery = {
    deliveryAddress: {
      street: '10 Test Road',
      addressLine2: '',
      city: 'Lagos',
      region: 'Lagos',
      country: 'Nigeria',
      postalCode: '00100',
    },
    recipient: { name: 'Amina', phone: '+2348000000001' },
  };
  const addresses = { context: vi.fn(async () => delivery) };
  return {
    db,
    item,
    delivery,
    addresses,
    service: new ChatPaymentService(db as never, addresses as never),
  };
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

describe('purchase delivery details', () => {
  it('requires an address for unclassified items and returns the owner context', async () => {
    const { service, addresses, delivery } = setup();
    expect(await service.instructions('owner', 'chat', 'message', 'item')).toMatchObject({
      requiresDelivery: true,
      ...delivery,
    });
    expect(addresses.context).toHaveBeenCalledWith('owner');
  });
  it('returns missing address and phone without inventing recipient details', async () => {
    const { service, addresses } = setup();
    addresses.context.mockResolvedValue({
      deliveryAddress: null,
      recipient: { name: 'Amina', phone: null },
    } as never);
    expect(await service.instructions('owner', 'chat', 'message', 'item')).toMatchObject({
      requiresDelivery: true,
      deliveryAddress: null,
      recipient: { name: 'Amina', phone: null },
    });
  });
  it.each(['FLIGHT', 'SUBSCRIPTION', 'SOFTWARE'] as const)(
    'does not require delivery for %s',
    async (mode) => {
      const { service, item, addresses } = setup();
      item.preview = { mode };
      expect(await service.instructions('owner', 'chat', 'message', 'item')).toMatchObject({
        requiresDelivery: false,
        deliveryAddress: null,
        recipient: null,
      });
      expect(addresses.context).not.toHaveBeenCalled();
    },
  );
  it('requires delivery for retail', async () => {
    const { service, item } = setup();
    item.preview = { mode: 'RETAIL' };
    expect((await service.instructions('owner', 'chat', 'message', 'item')).requiresDelivery).toBe(
      true,
    );
  });
  it.each([true, false])(
    'honors the trusted explicit requiresDelivery flag %s',
    async (requiresDelivery) => {
      const { service, item } = setup();
      item.requiresDelivery = requiresDelivery;
      item.preview = { mode: requiresDelivery ? 'SOFTWARE' : 'RETAIL' };
      expect(
        (await service.instructions('owner', 'chat', 'message', 'item')).requiresDelivery,
      ).toBe(requiresDelivery);
    },
  );
  it('rejects an unowned proposal before loading any address', async () => {
    const { service, db, addresses } = setup();
    db.chat.findFirst.mockResolvedValue(null as never);
    await expect(service.instructions('other', 'chat', 'message', 'item')).rejects.toThrow(
      'Chat not found',
    );
    expect(addresses.context).not.toHaveBeenCalled();
  });
});
