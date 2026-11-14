import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { AssistantReplyDto } from './chat-replies.dto.js';
import { prepareSubscriptionCheckout } from './subscription-catalog.js';
import { SubscriptionReminders } from './subscription-reminders.service.js';

describe('subscription checkout assistance', () => {
  for (const service of ['netflix', 'spotify']) {
    for (const intent of ['NEW', 'RENEW']) {
      it(`provides official ${service} ${intent} assistance without a price or payment claim`, async () => {
        const card = prepareSubscriptionCheckout(service, 'ng', intent);
        const dto = plainToInstance(AssistantReplyDto, {
          text: 'Review checkout',
          items: [],
          subscriptions: [card],
        });
        expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
        expect(card.countryCode).toBe('NG');
        expect(new URL(card.checkoutUrl).hostname).toBe(`www.${service}.com`);
        expect(card).toMatchObject({
          activationStatus: 'UNVERIFIED',
          priceStatus: 'CHECK_AT_CHECKOUT',
        });
        expect(card).not.toHaveProperty('amount');
        expect(card).not.toHaveProperty('autoRenew');
        expect(card.billingNote).toContain('has not charged');
      });
    }
  }
  it.each([
    ['other', 'NG', 'NEW'],
    ['__proto__', 'NG', 'NEW'],
    ['netflix', '', 'NEW'],
    ['spotify', 'ZZ', 'NEW'],
    ['netflix', 'NG', 'BUY'],
  ])('rejects unsupported details %s %s %s', (service, country, intent) => {
    expect(() => prepareSubscriptionCheckout(service, country, intent)).toThrow(
      BadRequestException,
    );
  });
});

function setup() {
  const card = prepareSubscriptionCheckout('netflix', 'NG', 'NEW');
  const dueAt = new Date(Date.now() + 86_400_000);
  const reminder = {
    id: 'reminder',
    userId: 'owner',
    messageId: 'message',
    subscriptionId: card.id,
    serviceId: card.serviceId,
    countryCode: 'NG',
    dueAt,
    updatedAt: new Date(),
    message: { chatId: 'chat' },
  };
  const db = {
    $queryRaw: vi.fn(async () => [{ id: 'owner' }]),
    message: {
      findFirst: vi.fn(async () => ({
        content: JSON.stringify({ version: 1, subscriptions: [card] }),
      })),
    },
    subscriptionReminder: {
      findUnique: vi.fn(async () => null as unknown),
      count: vi.fn(async () => 0),
      upsert: vi.fn(async () => reminder),
      findMany: vi.fn(async () => [reminder]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    notification: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  const prisma = { ...db, $transaction: async (fn: (tx: typeof db) => unknown) => fn(db) };
  return { service: new SubscriptionReminders(prisma as never), db, card, reminder, dueAt };
}

describe('subscription reminder guards and delivery', () => {
  it('requires an owned assistant message containing the requested server card', async () => {
    const { service, db, card, dueAt } = setup();
    await service.schedule('owner', 'message', card.id, dueAt);
    expect(db.message.findFirst).toHaveBeenCalledWith({
      where: { id: 'message', role: 'ASSISTANT', chat: { userId: 'owner' } },
    });
    expect(db.subscriptionReminder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_messageId_subscriptionId: {
            userId: 'owner',
            messageId: 'message',
            subscriptionId: card.id,
          },
        },
        update: { dueAt, status: 'SCHEDULED' },
      }),
    );
    expect(db.auditLog.create).toHaveBeenCalled();
  });
  it('rejects another card or missing message before scheduling', async () => {
    const { service, db, dueAt } = setup();
    await expect(service.schedule('owner', 'message', 'unknown', dueAt)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    db.message.findFirst.mockResolvedValue(null as never);
    await expect(
      service.schedule('other-user', 'message', 'unknown', dueAt),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.subscriptionReminder.upsert).not.toHaveBeenCalled();
  });
  it('rejects past, invalid and excessively distant reminder times', async () => {
    const { service, db, card } = setup();
    for (const date of [new Date(0), new Date('invalid'), new Date(Date.now() + 367 * 86_400_000)])
      await expect(service.schedule('owner', 'message', card.id, date)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    expect(db.message.findFirst).not.toHaveBeenCalled();
  });
  it('caps active reminders while allowing an existing reminder to be rescheduled', async () => {
    const { service, db, card, dueAt } = setup();
    db.subscriptionReminder.count.mockResolvedValue(50);
    await expect(service.schedule('owner', 'message', card.id, dueAt)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    db.subscriptionReminder.findUnique.mockResolvedValue({ status: 'SCHEDULED' });
    await service.schedule('owner', 'message', card.id, dueAt);
    expect(db.subscriptionReminder.upsert).toHaveBeenCalledTimes(1);
  });
  it('cancels only owned scheduled reminders and never touches payment records', async () => {
    const { service, db } = setup();
    await service.cancel('owner', 'reminder');
    expect(db.subscriptionReminder.updateMany).toHaveBeenCalledWith({
      where: { id: 'reminder', userId: 'owner', status: 'SCHEDULED' },
      data: { status: 'CANCELLED' },
    });
    db.subscriptionReminder.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.cancel('other-user', 'reminder')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('concurrent delivery attempts create one notification after a conditional claim', async () => {
    const { service, db, reminder } = setup();
    let claimed = false;
    db.subscriptionReminder.updateMany.mockImplementation(async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });
    await Promise.all([service.run(), service.run()]);
    expect(db.notification.create).toHaveBeenCalledTimes(1);
    expect(db.subscriptionReminder.updateMany).toHaveBeenCalledWith({
      where: {
        id: reminder.id,
        status: 'SCHEDULED',
        dueAt: reminder.dueAt,
        updatedAt: reminder.updatedAt,
      },
      data: { status: 'SENT' },
    });
    expect(db.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'owner',
        metadata: expect.objectContaining({ entityType: 'chat', entityId: 'chat' }),
        content: expect.stringContaining('No payment was made'),
      }),
    });
  });
  it('does not deliver a reminder whose date or status changed after the scan', async () => {
    const { service, db } = setup();
    db.subscriptionReminder.updateMany.mockResolvedValue({ count: 0 });
    await service.run();
    expect(db.notification.create).not.toHaveBeenCalled();
  });
});
