import {
  BadRequestException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { prepareSubscriptionCheckout, subscriptionServices } from './subscription-catalog.js';

@Injectable()
export class SubscriptionReminders implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly prisma: PrismaService) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.run().catch(() => undefined), 30_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async schedule(userId: string, messageId: string, subscriptionId: string, dueAt: Date) {
    const now = Date.now();
    if (
      !Number.isFinite(dueAt.getTime()) ||
      dueAt.getTime() <= now ||
      dueAt.getTime() > now + 366 * 86_400_000
    )
      throw new BadRequestException('Choose a future reminder within the next year.');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM profiles WHERE id=${userId}::uuid FOR UPDATE`;
      const message = await tx.message.findFirst({
        where: { id: messageId, role: 'ASSISTANT', chat: { userId } },
      });
      let envelope;
      try {
        envelope = message ? JSON.parse(message.content) : null;
      } catch {
        envelope = null;
      }
      const card =
        envelope?.version === 1 && Array.isArray(envelope.subscriptions)
          ? envelope.subscriptions.find((s: { id?: string }) => s?.id === subscriptionId)
          : null;
      if (
        !card ||
        typeof card.serviceId !== 'string' ||
        typeof card.countryCode !== 'string' ||
        typeof card.intent !== 'string'
      )
        throw new NotFoundException('Subscription assistance not found.');
      const trusted = prepareSubscriptionCheckout(card.serviceId, card.countryCode, card.intent);
      const identity = { userId, messageId, subscriptionId };
      const existing = await tx.subscriptionReminder.findUnique({
        where: { userId_messageId_subscriptionId: identity },
      });
      if (
        existing?.status !== 'SCHEDULED' &&
        (await tx.subscriptionReminder.count({ where: { userId, status: 'SCHEDULED' } })) >= 50
      )
        throw new BadRequestException('You can have up to 50 active subscription reminders.');
      const reminder = await tx.subscriptionReminder.upsert({
        where: { userId_messageId_subscriptionId: identity },
        create: {
          id: randomUUID(),
          ...identity,
          serviceId: trusted.serviceId,
          countryCode: trusted.countryCode,
          dueAt,
        },
        update: { dueAt, status: 'SCHEDULED' },
      });
      await tx.auditLog.create({
        data: {
          id: randomUUID(),
          userId,
          action: 'subscription.reminder.schedule',
          entityType: 'subscription_reminder',
          entityId: reminder.id,
        },
      });
      return reminder;
    });
  }

  list(userId: string) {
    return this.prisma.subscriptionReminder.findMany({
      where: { userId, status: 'SCHEDULED' },
      orderBy: { dueAt: 'asc' },
      take: 50,
    });
  }
  async cancel(userId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.subscriptionReminder.updateMany({
        where: { id, userId, status: 'SCHEDULED' },
        data: { status: 'CANCELLED' },
      });
      if (!result.count) throw new NotFoundException('Scheduled reminder not found.');
      await tx.auditLog.create({
        data: {
          id: randomUUID(),
          userId,
          action: 'subscription.reminder.cancel',
          entityType: 'subscription_reminder',
          entityId: id,
        },
      });
      return { cancelled: true };
    });
  }
  async run() {
    const now = new Date();
    const due = await this.prisma.subscriptionReminder.findMany({
      where: { status: 'SCHEDULED', dueAt: { lte: now } },
      orderBy: { dueAt: 'asc' },
      take: 100,
      include: { message: { select: { chatId: true } } },
    });
    for (const reminder of due) {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.subscriptionReminder.updateMany({
          where: {
            id: reminder.id,
            status: 'SCHEDULED',
            dueAt: reminder.dueAt,
            updatedAt: reminder.updatedAt,
          },
          data: { status: 'SENT' },
        });
        if (!claimed.count) return;
        const service =
          subscriptionServices[reminder.serviceId as keyof typeof subscriptionServices];
        await tx.notification.create({
          data: {
            id: randomUUID(),
            userId: reminder.userId,
            type: 'CHAT',
            title: `${service.name} reminder`,
            content:
              'You asked to review this subscription today. Check your official account for the amount and renewal date. No payment was made by this reminder.',
            metadata: {
              action: 'subscription.reminder',
              entityType: 'chat',
              entityId: reminder.message.chatId,
              chatId: reminder.message.chatId,
            },
          },
        });
      });
    }
    return { processed: due.length };
  }
}
