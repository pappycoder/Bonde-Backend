import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ApprovalStatus,
  CardStatus,
  Prisma,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { money } from '../../common/money/money.js';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class WalletInsightsService {
  constructor(private readonly prisma: PrismaService) {}

  async budget(userId: string, now = new Date()) {
    const wallet = await this.prisma.wallet.findFirst({ where: { account: { userId } } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const where = {
      userId,
      walletId: wallet.id,
      metadata: { path: ['live'], equals: true },
      currency: 'NGN',
      status: TransactionStatus.SUCCESS,
      approvalStatus: ApprovalStatus.APPROVED,
      createdAt: { gte: start, lt: resetAt },
      type: { in: [TransactionType.PAYMENT, TransactionType.WITHDRAWAL] },
    };
    const [total, grouped, cards] = await Promise.all([
      this.prisma.transaction.aggregate({ where, _sum: { amount: true } }),
      this.prisma.transaction.groupBy({
        by: ['cardId'],
        where: { ...where, type: TransactionType.PAYMENT, cardId: { not: null } },
        _sum: { amount: true },
      }),
      this.prisma.card.findMany({
        where: {
          userId,
          issuer: 'sudo',
          currency: 'NGN',
          status: { in: [CardStatus.ACTIVE, CardStatus.PAUSED] },
          monthlyLimit: { gt: 0 },
        },
        include: { locks: { where: { isActive: true }, orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      walletId: wallet.id,
      currency: 'NGN',
      monthlyBudget: wallet.monthlyBudget === null ? null : money(wallet.monthlyBudget),
      spent: money(total._sum.amount ?? 0),
      cardSpent: money(
        grouped.reduce((sum, row) => sum.add(row._sum.amount ?? 0), new Prisma.Decimal(0)),
      ),
      cardLimit: money(
        cards.reduce((sum, card) => sum.add(card.monthlyLimit ?? 0), new Prisma.Decimal(0)),
      ),
      periodStart: start.toISOString(),
      resetAt: resetAt.toISOString(),
      daysRemaining: Math.ceil((resetAt.getTime() - now.getTime()) / 86400000),
      allocations: cards.map((card) => ({
        id: card.id,
        cardName: card.nickname?.trim() || 'Virtual card',
        last4: card.cardNumberLast4,
        monthlyLimit: money(card.monthlyLimit ?? 0),
        spent: money(grouped.find((row) => row.cardId === card.id)?._sum.amount ?? 0),
        lockTypes: card.locks.map((lock) => lock.lockType),
      })),
    };
  }

  async updateBudget(userId: string, amount: string) {
    const value = new Prisma.Decimal(amount);
    if (!value.isFinite() || value.lte(0) || value.gt('9999999999999.99'))
      throw new BadRequestException('Monthly budget must be a positive amount');
    const updated = await this.prisma.wallet.updateMany({
      where: { account: { userId } },
      data: { monthlyBudget: value },
    });
    if (!updated.count) throw new NotFoundException('Wallet not found');
    return this.budget(userId);
  }

  async categorize(userId: string, id: string, category: string) {
    // Atomic JSON-key update preserves payment/provider metadata and never
    // changes a transaction's amount, status or approval.
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "transactions" SET "metadata" = jsonb_set(
        CASE WHEN jsonb_typeof("metadata") = 'object' THEN "metadata" ELSE '{}'::jsonb END,
        '{walletCategory}', to_jsonb(${category}::text), true), "updated_at" = NOW()
      WHERE "id" = ${id}::uuid AND "user_id" = ${userId}::uuid
        AND "type" IN ('PAYMENT', 'WITHDRAWAL', 'TRANSFER') RETURNING "id"`;
    if (!rows.length) throw new NotFoundException('Outgoing transaction not found');
    return { id, category };
  }
}
