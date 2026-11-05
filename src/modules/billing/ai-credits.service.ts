import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type AiCreditGrant } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class CreditsRequiredException extends HttpException {
  constructor() {
    super(
      {
        code: 'AI_CREDITS_REQUIRED',
        message: 'You have no available AI credits. Buy credits to continue chatting.',
      },
      402,
    );
  }
}

/** Every caller holds the owning profile row until its transaction commits. */
@Injectable()
export class AiCreditsService {
  async lock(tx: Prisma.TransactionClient, userId: string) {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM profiles WHERE id=${userId}::uuid FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Profile not found');
  }

  async initialize(tx: Prisma.TransactionClient, userId: string) {
    const account = await tx.aiCreditAccount.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    if (!account.ledgerInitialized) {
      for (const [source, units, expiresAt] of [
        ['PLAN', account.planRemaining, account.periodEnd],
        ['WELCOME', account.welcomeRemaining, null],
        ['PURCHASED', account.purchasedRemaining, null],
      ] as const) {
        if (units > 0)
          await this.add(tx, userId, source, `backfill:${userId}:${source}`, units, expiresAt);
      }
      await tx.aiCreditAccount.update({ where: { userId }, data: { ledgerInitialized: true } });
    }
    await this.expire(tx, userId);
  }

  async add(
    tx: Prisma.TransactionClient,
    userId: string,
    source: string,
    sourceKey: string,
    units: number,
    expiresAt: Date | null = null,
  ) {
    if (!Number.isSafeInteger(units) || units <= 0) throw new Error('Invalid credit grant');
    const prior = await tx.aiCreditGrant.findUnique({ where: { sourceKey } });
    if (prior) {
      if (prior.userId !== userId || prior.source !== source || prior.units !== units)
        throw new Error('Credit grant identity mismatch');
      return prior;
    }
    const grant = await tx.aiCreditGrant.create({
      data: { id: randomUUID(), userId, source, sourceKey, units, remaining: units, expiresAt },
    });
    await this.entry(tx, grant, `grant:${sourceKey}`, 'GRANT', units, 0);
    return grant;
  }

  async expire(tx: Prisma.TransactionClient, userId: string) {
    const expired = await tx.aiCreditGrant.findMany({
      where: { userId, expiresAt: { lte: new Date() }, remaining: { gt: 0 } },
    });
    for (const grant of expired) {
      await tx.aiCreditGrant.update({ where: { id: grant.id }, data: { remaining: 0 } });
      await this.entry(tx, grant, `expire:${grant.id}`, 'EXPIRE', -grant.remaining, 0);
    }
  }

  async reserve(tx: Prisma.TransactionClient, userId: string, reference: string) {
    await this.initialize(tx, userId);
    const grants = await tx.aiCreditGrant.findMany({
      where: {
        userId,
        remaining: { gt: 0 },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const priority: Record<string, number> = { PLAN: 0, WELCOME: 1, PURCHASED: 2 };
    grants.sort((a, b) => (priority[a.source] ?? 3) - (priority[b.source] ?? 3));
    const grant = grants[0];
    if (!grant) throw new CreditsRequiredException();
    await tx.aiCreditGrant.update({
      where: { id: grant.id },
      data: { remaining: { decrement: 1 }, reserved: { increment: 1 } },
    });
    await this.entry(tx, grant, `reserve:${reference}`, 'RESERVE', -1, 1);
    await this.project(tx, userId);
    return grant.id;
  }

  async finish(
    tx: Prisma.TransactionClient,
    userId: string,
    grantId: string,
    reference: string,
    consume: boolean,
  ) {
    const grant = await tx.aiCreditGrant.findFirstOrThrow({ where: { id: grantId, userId } });
    const expired = grant.expiresAt !== null && grant.expiresAt <= new Date();
    const release = !consume && !expired;
    const changed = await tx.aiCreditGrant.updateMany({
      where: { id: grantId, reserved: { gt: 0 } },
      data: { reserved: { decrement: 1 }, ...(release ? { remaining: { increment: 1 } } : {}) },
    });
    if (!changed.count) throw new Error('Credit reservation missing');
    await this.entry(
      tx,
      grant,
      `finish:${reference}`,
      consume ? 'CONSUME' : expired ? 'RELEASE_EXPIRED' : 'RELEASE',
      release ? 1 : 0,
      -1,
    );
    if (consume && grant.source === 'PLAN') {
      await tx.aiCreditAccount.updateMany({
        where: { userId, periodEnd: grant.expiresAt },
        data: { planUsed: { increment: 1 } },
      });
    }
    await this.project(tx, userId);
  }

  async project(tx: Prisma.TransactionClient, userId: string) {
    await this.expire(tx, userId);
    const grants = await tx.aiCreditGrant.findMany({ where: { userId } });
    const available = (source: string) =>
      grants
        .filter((g) => g.source === source && (!g.expiresAt || g.expiresAt > new Date()))
        .reduce((sum, g) => sum + g.remaining, 0);
    const account = await tx.aiCreditAccount.update({
      where: { userId },
      data: {
        welcomeRemaining: available('WELCOME'),
        planRemaining: available('PLAN'),
        purchasedRemaining: available('PURCHASED'),
      },
    });
    const total = account.welcomeRemaining + account.planRemaining + account.purchasedRemaining;
    return {
      welcome: account.welcomeRemaining,
      plan: account.planRemaining,
      purchased: account.purchasedRemaining,
      granted: account.planGranted,
      used: account.planUsed,
      total,
      spendable: total,
      reserved: grants.reduce((sum, g) => sum + g.reserved, 0),
      periodEnd: account.periodEnd,
      canChat: total > 0,
      replyCost: 1,
      purchasedExpire: false,
    };
  }

  private entry(
    tx: Prisma.TransactionClient,
    grant: AiCreditGrant,
    reference: string,
    kind: string,
    availableDelta: number,
    reservedDelta: number,
  ) {
    return tx.aiCreditEntry.create({
      data: {
        id: randomUUID(),
        userId: grant.userId,
        grantId: grant.id,
        reference,
        kind,
        availableDelta,
        reservedDelta,
      },
    });
  }
}
