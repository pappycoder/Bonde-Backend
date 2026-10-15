import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ChatCheckoutService } from './chat-checkout.service.js';
import { UnconfiguredChatCheckoutGateway } from './chat-checkout.gateway.js';

function setup() {
  const item = {
    id: 'item',
    approvalId: 'approval',
    decision: 'APPROVED',
    merchant: 'Shop',
    amount: '49.00',
    currency: 'USD',
    authorizedLimit: '50.00',
  };
  const transaction = {
    id: 'transaction',
    userId: 'owner',
    chatId: 'chat',
    cardId: null as string | null,
    amount: new Prisma.Decimal('49.00'),
    currency: 'USD',
    type: 'PAYMENT',
    status: 'PENDING',
    updatedAt: new Date('2026-10-15T10:00:00Z'),
    metadata: { unrelated: 'preserved' } as Record<string, unknown>,
  };
  const approval = { status: 'APPROVED', transaction };
  const card = {
    id: 'card',
    userId: 'owner',
    status: 'ACTIVE',
    cardNumberLast4: '4242',
    expirationDate: null,
    maxSpendLimit: new Prisma.Decimal('50.00'),
  };
  const prisma = {
    chat: { findFirst: vi.fn(async () => ({ id: 'chat' })) },
    message: {
      findFirst: vi.fn(async () => ({ content: JSON.stringify({ version: 1, items: [item] }) })),
    },
    transactionApproval: { findFirst: vi.fn(async () => approval) },
    transaction: {
      findFirst: vi.fn(async () => transaction),
      update: vi.fn(async ({ data }) => {
        Object.assign(transaction, data);
        return transaction;
      }),
    },
    card: { findFirst: vi.fn(async () => card) },
    $queryRaw: vi.fn(async () => [{ id: 'transaction' }]),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  const gateway = {
    assertConfigured: vi.fn(),
    start: vi.fn(async () => ({ status: 'PROCESSING', cardId: 'card' })),
    status: vi.fn(async () => ({ status: 'PROCESSING', cardId: 'card' })),
    cancel: vi.fn(async () => ({ status: 'CANCELLED', cardId: 'card' })),
  };
  const service = new ChatCheckoutService(prisma as never, gateway as never);
  return { service, prisma, gateway, transaction, item, approval, card };
}
const ids = ['owner', 'chat', 'message', 'item'] as const;
describe('chat checkout', () => {
  it('does not pretend a merchant or card issuer is configured', () => {
    expect(() => new UnconfiguredChatCheckoutGateway().assertConfigured()).toThrow(
      ServiceUnavailableException,
    );
  });
  it('rejects another owner before invoking checkout', async () => {
    const { service, prisma, gateway } = setup();
    prisma.chat.findFirst.mockResolvedValue(null as never);
    await expect(service.start(...ids, { method: 'ONE_TIME' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(gateway.start).not.toHaveBeenCalled();
  });
  it('requires an approved purchase and matching quote', async () => {
    const { service, approval, transaction, gateway } = setup();
    approval.status = 'PENDING';
    await expect(service.start(...ids, { method: 'ONE_TIME' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    approval.status = 'APPROVED';
    transaction.amount = new Prisma.Decimal('99.00');
    await expect(service.start(...ids, { method: 'ONE_TIME' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(gateway.start).not.toHaveBeenCalled();
  });
  it('passes server quote and one-use issuance requirements to the trusted integration', async () => {
    const { service, gateway, transaction } = setup();
    const result = await service.start(...ids, { method: 'ONE_TIME' });
    expect(gateway.start).toHaveBeenCalledWith({
      userId: 'owner',
      transactionId: 'transaction',
      method: 'ONE_TIME',
      cardId: undefined,
      amount: '49.00',
      currency: 'USD',
      merchant: 'Shop',
      spendingLimit: '50.00',
    });
    expect(result.status).toBe('PROCESSING');
    expect(transaction.metadata.unrelated).toBe('preserved');
    expect(result.oneTimeClosed).toBe(false);
  });
  it('uses an existing owner card and rejects missing, paused and insufficient-limit cards', async () => {
    const { service, prisma, card } = setup();
    await expect(service.start(...ids, { method: 'EXISTING' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    prisma.card.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      service.start(...ids, { method: 'EXISTING', cardId: 'other' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    card.status = 'PAUSED';
    await expect(
      service.start(...ids, { method: 'EXISTING', cardId: 'card' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    card.status = 'ACTIVE';
    card.maxSpendLimit = new Prisma.Decimal('10');
    await expect(
      service.start(...ids, { method: 'EXISTING', cardId: 'card' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    card.maxSpendLimit = new Prisma.Decimal('50');
    expect((await service.start(...ids, { method: 'EXISTING', cardId: 'card' })).method).toBe(
      'EXISTING',
    );
  });
  it('reuses a claimed checkout instead of creating another card or charge', async () => {
    const { service, gateway } = setup();
    await service.start(...ids, { method: 'ONE_TIME' });
    await service.start(...ids, { method: 'ONE_TIME' });
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(gateway.status).toHaveBeenCalledTimes(1);
    await expect(
      service.start(...ids, { method: 'EXISTING', cardId: 'card' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('keeps the claim after an uncertain provider response and checks status on retry', async () => {
    const { service, gateway } = setup();
    gateway.start.mockRejectedValueOnce(new Error('Timeout after submission'));
    await expect(service.start(...ids, { method: 'ONE_TIME' })).rejects.toThrow('Timeout');
    await service.start(...ids, { method: 'ONE_TIME' });
    expect(gateway.start).toHaveBeenCalledTimes(1);
  });
  it('does not show paid success until the actual transaction has reconciled', async () => {
    const { service, gateway, transaction, card } = setup();
    await service.start(...ids, { method: 'ONE_TIME' });
    gateway.status.mockResolvedValue({ status: 'SUCCESS', cardId: 'card' });
    expect((await service.progress(...ids)).status).toBe('PROCESSING');
    transaction.status = 'SUCCESS';
    transaction.cardId = 'card';
    card.status = 'CANCELLED';
    const result = await service.progress(...ids);
    expect(result.status).toBe('SUCCESS');
    expect(result.oneTimeClosed).toBe(true);
    expect(result.amount).toBe('49.00');
    expect(result.cardLast4).toBe('4242');
    transaction.updatedAt = new Date('2026-10-16T00:00:00Z');
    expect((await service.progress(...ids)).completedAt).toBe(result.completedAt);
  });
  it('cancels through the provider and does not turn a pending cancellation into confirmation', async () => {
    const { service, gateway } = setup();
    await service.start(...ids, { method: 'ONE_TIME' });
    gateway.cancel.mockResolvedValueOnce({ status: 'PROCESSING', cardId: 'card' });
    expect((await service.progress(...ids, true)).status).toBe('PROCESSING');
    expect((await service.progress(...ids, true)).status).toBe('CANCELLED');
    expect((await service.progress(...ids)).status).toBe('CANCELLED');
  });
  it('rejects a mismatched provider card', async () => {
    const { service, gateway } = setup();
    await service.start(...ids, { method: 'EXISTING', cardId: 'card' });
    gateway.status.mockResolvedValue({ status: 'SUCCESS', cardId: 'other-card' });
    await expect(service.progress(...ids)).rejects.toBeInstanceOf(BadGatewayException);
  });
});
