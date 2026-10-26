import { Injectable } from '@nestjs/common';
import { Prisma, type Card, type CardLock } from '@prisma/client';
import { validateRules, type CardRules } from './card-policy.js';

@Injectable()
export class FinancePolicy {
  async snapshot(
    tx: Prisma.TransactionClient,
    card: Card & { locks?: CardLock[] },
    now = new Date(),
  ) {
    const locks =
      card.locks ?? (await tx.cardLock.findMany({ where: { cardId: card.id, isActive: true } }));
    let rule: CardRules = {};
    let controlsValid = true;
    try {
      if (card.creationLockType) {
        if (locks.length !== 1 || locks[0].lockType !== card.creationLockType)
          throw new Error('Conflicting primary controls');
        rule = validateRules(locks[0].config as Record<string, unknown>);
        if (rule.type !== card.creationLockType)
          throw new Error('Missing primary control configuration');
      } else if (locks.length) throw new Error('Unexpected controls on a standard card');
    } catch {
      controlsValid = false;
      rule = {};
    }
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [captures, total, holds] = await Promise.all([
      tx.financeCapture.findMany({
        where: { cardId: card.id, isPurchase: true },
        distinct: ['authorizationId'],
        select: { authorizationId: true },
      }),
      tx.financeCapture.aggregate({
        where: { cardId: card.id, bookedAt: { gte: month }, currency: card.currency },
        _sum: { amount: true },
      }),
      tx.financeAuthorization.findMany({ where: { cardId: card.id, status: 'HELD' } }),
    ]);
    const completed = new Set(captures.map((row) => row.authorizationId));
    const reserved = holds.filter(
      (row) => row.requestType === 'PURCHASE' && !completed.has(row.id),
    ).length;
    const held = holds.reduce((sum, row) => {
      const remaining = row.amount.sub(row.settled).sub(row.released);
      if (remaining.lt(0)) throw new Error('Invalid authorization reservation');
      return sum.add(remaining);
    }, new Prisma.Decimal(0));
    const deadline = new Date(
      Math.min(
        card.expirationDate.getTime(),
        card.controlExpiresAt?.getTime() ?? Infinity,
        rule.type === 'TIME' ? Date.parse(rule.end!) : Infinity,
      ),
    );
    const reason =
      card.retirementReason ??
      (deadline <= now
        ? 'TIME_EXPIRED'
        : rule.type === 'SELF_DESTRUCT' && completed.size >= rule.usageLimit!
          ? 'USAGE_LIMIT'
          : null);
    return {
      rule,
      controlsValid,
      spent: (total._sum.amount ?? new Prisma.Decimal(0)).add(held),
      settled: total._sum.amount ?? new Prisma.Decimal(0),
      held,
      uses: completed.size + reserved,
      completedUses: completed.size,
      reason,
      deadline,
    };
  }
}
