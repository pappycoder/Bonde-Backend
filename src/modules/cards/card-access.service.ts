import { FinancePolicy } from '../finance/finance-policy.service.js';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { LockType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

type Reader = Pick<Prisma.TransactionClient, 'profile' | 'card'>;

@Injectable()
export class CardAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: FinancePolicy,
  ) {}

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
      where: {
        userId,
        issuer: 'sudo',
        status: { in: ['ACTIVE', 'PAUSED'] },
        OR: [{ retirementStatus: null }, { retirementStatus: { notIn: ['RETIRED', 'CLOSED'] } }],
      },
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
      standard: { active: standard, limit: premium ? 15 : 1 },
      ruleBased: { active: ruleBased, limit: premium ? 15 : 2 },
      retained: !premium && (standard > 1 || ruleBased > 2),
      canCreateStandard: premium ? cards.length < 15 : standard < 1 && ruleBased <= 2,
      canCreateRuleBased: premium ? cards.length < 15 : ruleBased < 2 && standard <= 1,
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
      where: { id, userId, issuer: 'sudo' },
      include: { locks: { where: { isActive: true } } },
    });
    if (!card) throw new NotFoundException('Card not found');
    const snapshot = await this.policy.snapshot(this.prisma, card);
    if (card.retiredAt || snapshot.reason)
      return {
        reason: 'RETIRED',
        retirementReason: snapshot.reason,
        retirementStatus: card.retirementStatus ?? 'RETIRING',
      };
    if (card.status === 'CANCELLED') return { reason: 'CLOSED' };
    if (snapshot.rule.type === 'MERCHANT' && !snapshot.rule.merchantIds?.length)
      return { reason: 'MERCHANT_SETUP' };
    if (snapshot.rule.type === 'SELF_DESTRUCT' && snapshot.uses >= snapshot.rule.usageLimit!)
      return { reason: 'USAGE_RESERVED', used: snapshot.uses, limit: snapshot.rule.usageLimit };
    if (card.monthlyLimit && snapshot.spent.gte(card.monthlyLimit))
      return {
        reason: 'BUDGET_LIMIT',
        spent: snapshot.spent.toFixed(2),
        limit: card.monthlyLimit.toFixed(2),
        resetsAt: new Date(
          Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1),
        ).toISOString(),
      };
    // maxSpendLimit is per transaction, never compared with lifetime totalSpent.
    return { reason: 'NONE' };
  }
}
