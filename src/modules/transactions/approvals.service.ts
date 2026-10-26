import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parsePaging, toPageResult } from '../../common/paging/paging.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const cardSelect = {
  id: true,
  cardNumberLast4: true,
  cardType: true,
  createdAt: true,
  totalSpent: true,
} as const;
type Row = Prisma.FinanceAuthorizationGetPayload<{
  include: { card: { select: typeof cardSelect } };
}>;

/** Card authorization approvals. Chat proposal decisions remain in their chat. */
@Injectable()
export class ApprovalsService {
  constructor(private readonly prisma: PrismaService) {}
  async list(
    userId: string,
    options: { page?: number; pageSize?: number; q?: string; filter?: string | string[] } = {},
  ) {
    const { page, pageSize, skip, take } = parsePaging(options.page, options.pageSize);
    const filter = [options.filter ?? ''].flat().join(',');
    const now = new Date();
    const effectiveStatus: Prisma.FinanceAuthorizationWhereInput = filter.includes('PENDING')
      ? { status: 'AWAITING_APPROVAL' }
      : filter.includes('APPROVED')
        ? {
            OR: [
              { status: 'APPROVAL_USED' },
              { status: 'RETRY_APPROVED', approvalExpiresAt: { gt: now } },
            ],
          }
        : filter.includes('DECLINED')
          ? {
              OR: [
                { status: { in: ['DECLINED', 'EXPIRED'] } },
                { status: 'RETRY_APPROVED', approvalExpiresAt: { lte: now } },
              ],
            }
          : {
              status: {
                in: ['AWAITING_APPROVAL', 'RETRY_APPROVED', 'APPROVAL_USED', 'DECLINED', 'EXPIRED'],
              },
            };
    const where: Prisma.FinanceAuthorizationWhereInput = {
      userId,
      ...effectiveStatus,
      ...(options.q?.trim()
        ? { merchantName: { contains: options.q.trim(), mode: 'insensitive' } }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.financeAuthorization.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: { card: { select: cardSelect } },
      }),
      this.prisma.financeAuthorization.count({ where }),
    ]);
    return toPageResult(
      items.map((row) => this.view(row)),
      total,
      page,
      pageSize,
    );
  }
  async get(userId: string, id: string) {
    const row = await this.prisma.financeAuthorization.findFirst({
      where: { id, userId },
      include: { card: { select: cardSelect } },
    });
    if (!row) throw new NotFoundException('Approval not found');
    return this.view(row);
  }
  private view(row: Row) {
    const approved = ['RETRY_APPROVED', 'APPROVAL_USED'].includes(row.status);
    const expired =
      row.status === 'RETRY_APPROVED' &&
      (!row.approvalExpiresAt || row.approvalExpiresAt <= new Date());
    return {
      id: row.id,
      transactionId: row.id,
      authorizationId: row.id,
      status:
        row.status === 'AWAITING_APPROVAL'
          ? 'PENDING'
          : approved && !expired
            ? 'APPROVED'
            : 'DECLINED',
      createdAt: row.createdAt,
      approvalExpiresAt: row.approvalExpiresAt,
      notes:
        'Approval permits one matching merchant retry within five minutes. It does not complete a purchase.',
      transaction: {
        description: row.merchantName || 'Card purchase',
        type: 'PAYMENT',
        amount: row.amount.toFixed(2),
        currency: row.currency,
        frequency: 'ONE_TIME',
        isRecurring: false,
        thresholdWarning: true,
      },
      card: { ...row.card, totalSpent: row.card.totalSpent.toFixed(2) },
    };
  }
}
