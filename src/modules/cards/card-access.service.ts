import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { LockType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

type Reader = Pick<Prisma.TransactionClient, 'profile' | 'card' | 'transaction'>;

@Injectable()
export class CardAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(userId: string, db: Reader = this.prisma) {
    const now = new Date();
    const profile = await db.profile.findUnique({
      where: { id: userId },
      select: { cardPlan: true, cardPlanExpiresAt: true },
    });
    if (!profile) throw new NotFoundException('Profile not found');
    const subscriptionExpired =
      profile.cardPlanExpiresAt != null && profile.cardPlanExpiresAt <= now;
    const premium = profile.cardPlan === 'PREMIUM' && !subscriptionExpired;
    // Pausing does not free an issued-card slot. Expired/destroyed cards do.
    const cards = await db.card.findMany({
      where: { userId, status: { in: ['ACTIVE', 'PAUSED'] }, expirationDate: { gt: now } },
      select: {
        creationLockType: true,
        locks: { select: { id: true }, where: { isActive: true } },
      },
    });
    const ruleBased = cards.filter(
      (card) => card.creationLockType != null || card.locks.length > 0,
    ).length;
    const standard = cards.length - ruleBased;
    return {
      plan: premium ? 'PREMIUM' : 'FREE',
      subscriptionExpired,
      standard: { active: standard, limit: premium ? null : 1 },
      ruleBased: { active: ruleBased, limit: premium ? null : 2 },
      retained: !premium && (standard > 1 || ruleBased > 2),
      canCreateStandard: premium || (standard < 1 && ruleBased <= 2),
      canCreateRuleBased: premium || (ruleBased < 2 && standard <= 1),
    };
  }

  async assertCreation(userId: string, ruleType?: LockType, db: Reader = this.prisma) {
    const access = await this.summary(userId, db);
    if (ruleType ? access.canCreateRuleBased : access.canCreateStandard) return;
    throw new ForbiddenException(
      'Your active-card limit is reached. Your existing cards remain available.',
    );
  }

  async cardStatus(userId: string, id: string) {
    const card = await this.prisma.card.findFirst({
      where: { id, userId },
      include: { locks: { where: { isActive: true } } },
    });
    if (!card) throw new NotFoundException('Card not found');
    if (card.status === 'CANCELLED') return { reason: 'NONE' };
    if (card.expirationDate <= new Date()) return { reason: 'EXPIRED' };
    const where = {
      cardId: id,
      userId,
      type: 'PAYMENT' as const,
      status: 'SUCCESS' as const,
      approvalStatus: 'APPROVED' as const,
    };
    const usage = card.locks.find((lock) => lock.lockType === 'SELF_DESTRUCT');
    const config = usage?.config as { usageLimit?: unknown } | undefined;
    if (typeof config?.usageLimit === 'number' && config.usageLimit > 0) {
      const used = await this.prisma.transaction.count({ where });
      if (used >= config.usageLimit)
        return { reason: 'USAGE_LIMIT', used, limit: config.usageLimit };
    }
    if (card.monthlyLimit != null) {
      const now = new Date();
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const sum = await this.prisma.transaction.aggregate({
        where: { ...where, createdAt: { gte: from, lt: to } },
        _sum: { amount: true },
      });
      const spent = sum._sum.amount ?? new Prisma.Decimal(0);
      if (spent.gte(card.monthlyLimit))
        return {
          reason: 'BUDGET_LIMIT',
          spent: spent.toFixed(2),
          limit: card.monthlyLimit.toFixed(2),
          resetsAt: to.toISOString(),
        };
    }
    // maxSpendLimit is per transaction, never compared with lifetime totalSpent.
    return { reason: 'NONE' };
  }
}
