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
  const delivery = {
    deliveryAddress: {
      id: 'addr-1',
      recipientName: 'Amina Sule',
      recipientPhone: '+2348000000001',
      street: '10 Test Road',
      addressLine2: '',
      city: 'Lagos',
      region: 'Lagos',
      lga: 'Ikorodu',
      country: 'Nigeria',
      postalCode: '00100',
      isDefault: true,
    },
    recipient: { name: 'Amina', phone: '+2348000000001' },
  };
  const content = () => JSON.stringify({ version: 1, items: [item] });
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'chat' }]),
    message: {
      findFirst: vi.fn(async () => ({ id: 'message', content: content() })),
      update: vi.fn(async (_args: { data: { content: string } }) => ({ id: 'message' })),
    },
    chat: { update: vi.fn(async () => ({ id: 'chat' })) },
  };
  const dbBase = {
    chat: { findFirst: vi.fn(async () => ({ id: 'chat' })) },
    message: { findFirst: vi.fn(async () => ({ id: 'message', content: content() })) },
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
  const db = {
    ...dbBase,
    $transaction: vi.fn(async (fn: (t: never) => Promise<unknown>) => fn(tx as never)),
  };
  const addresses = { context: vi.fn(async () => delivery) };
  return {
    db,
    tx,
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

const oneTime = {
  recipientName: 'Bola Ahmed',
  recipientPhone: '08012345678',
  street: '5 Marina Close',
  addressLine2: '',
  city: 'Ikoyi',
  region: 'Lagos',
  lga: 'Lagos Island',
  country: 'Nigeria',
  postalCode: '',
};

describe('one-time delivery addresses', () => {
  it('prefers the item snapshot over the saved default in instructions', async () => {
    const { service, item, addresses } = setup();
    item.deliveryAddress = oneTime;
    expect(await service.instructions('owner', 'chat', 'message', 'item')).toMatchObject({
      deliveryAddress: oneTime,
      recipient: { name: 'Bola Ahmed', phone: '08012345678' },
      oneTimeAddress: true,
    });
    expect(addresses.context).not.toHaveBeenCalled();
  });
  it('persists a validated snapshot onto the approved item without touching the address book', async () => {
    const { service, tx } = setup();
    expect(
      await service.setItemDeliveryAddress('owner', 'chat', 'message', 'item', oneTime),
    ).toEqual(oneTime);
    const saved = JSON.parse(tx.message.update.mock.calls[0][0].data.content);
    expect(saved.items[0].deliveryAddress).toEqual(oneTime);
    expect(tx.chat.update).toHaveBeenCalledWith({
      where: { id: 'chat' },
      data: { updatedAt: expect.any(Date) },
    });
  });
  it('refuses to attach an address to an unapproved proposal', async () => {
    const { service, item, tx } = setup();
    item.decision = 'PENDING';
    await expect(
      service.setItemDeliveryAddress('owner', 'chat', 'message', 'item', oneTime),
    ).rejects.toThrow('Approve this purchase first');
    expect(tx.message.update).not.toHaveBeenCalled();
  });
});
