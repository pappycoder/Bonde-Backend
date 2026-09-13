import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ApprovalStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { money } from '../../common/money/money.js';
import { parsePaging, toPageResult } from '../../common/paging/paging.js';
import {
  buildFilterWhere,
  type FilterFieldSpec,
  parseFilterEntries,
} from '../../common/paging/filter.js';
import { PrismaService } from '../../prisma/prisma.service.js';

interface PagedOptions {
  page?: number;
  pageSize?: number;
}

const APPROVAL_FILTER_FIELDS: Record<string, FilterFieldSpec> = {
  status: { kind: 'enum' },
};

/** Fetched approval rows always embed the transaction and its card (if any). */
const APPROVAL_INCLUDE = {
  transaction: { include: { card: true } },
} satisfies Prisma.TransactionApprovalInclude;

type ApprovalRow = Prisma.TransactionApprovalGetPayload<{ include: typeof APPROVAL_INCLUDE }>;

/**
 * Self-service approvals surface. Approvals belong to transactions, so
 * ownership is resolved through the owning user's transactions. Writes expose
 * the approval trail recording to the money-movement flows; `approvedBy` is
 * always the caller.
 */
@Injectable()
export class ApprovalsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    userId: string,
    options: PagedOptions & { q?: string; filter?: string | string[] } = {},
  ) {
    const { page, pageSize, skip, take } = parsePaging(options.page, options.pageSize);
    const where: Prisma.TransactionApprovalWhereInput = {
      transaction: { userId },
      ...buildFilterWhere(parseFilterEntries(options.filter), APPROVAL_FILTER_FIELDS),
    };
    const term = options.q?.trim();
    if (term) {
      where.OR = [
        { notes: { contains: term, mode: 'insensitive' } },
        { transaction: { description: { contains: term, mode: 'insensitive' } } },
      ];
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.transactionApproval.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: APPROVAL_INCLUDE,
      }),
      this.prisma.transactionApproval.count({ where }),
    ]);

    return toPageResult(
      items.map((item) => this.toView(item)),
      total,
      page,
      pageSize,
    );
  }

  async get(userId: string, approvalId: string) {
    const approval = await this.prisma.transactionApproval.findFirst({
      where: { id: approvalId, transaction: { userId } },
      include: APPROVAL_INCLUDE,
    });
    if (!approval) throw new NotFoundException('Approval not found');
    return this.toView(approval);
  }

  async create(
    userId: string,
    dto: { transactionId: string; status?: ApprovalStatus; notes?: string },
  ) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id: dto.transactionId, userId },
    });
    if (!transaction) throw new NotFoundException('Transaction not found');

    try {
      const approval = await this.prisma.transactionApproval.create({
        data: {
          id: randomUUID(),
          transactionId: dto.transactionId,
          status: dto.status ?? ApprovalStatus.PENDING,
          approvedBy: userId,
          notes: dto.notes ?? null,
        },
        include: APPROVAL_INCLUDE,
      });
      return this.toView(approval);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new BadRequestException('The referenced transaction does not exist');
      }
      throw error;
    }
  }

  async update(
    userId: string,
    approvalId: string,
    dto: { status?: ApprovalStatus; notes?: string },
  ) {
    const approval = await this.get(userId, approvalId);
    const data: Prisma.TransactionApprovalUpdateInput = {};
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.notes !== undefined) data.notes = dto.notes;
    const updated = await this.prisma.transactionApproval.update({
      where: { id: approval.id },
      data,
      include: APPROVAL_INCLUDE,
    });
    return this.toView(updated);
  }

  async remove(userId: string, approvalId: string) {
    const approval = await this.get(userId, approvalId);
    await this.prisma.transactionApproval.delete({ where: { id: approval.id } });
    return { deleted: true as const, id: approval.id };
  }

  private toView(approval: ApprovalRow) {
    const { transaction, ...rest } = approval;
    return {
      ...rest,
      transaction: { ...transaction, amount: money(transaction.amount) },
      card: transaction.card
        ? {
            id: transaction.card.id,
            cardNumberLast4: transaction.card.cardNumberLast4,
            cardType: transaction.card.cardType,
            createdAt: transaction.card.createdAt,
            totalSpent: money(transaction.card.totalSpent),
          }
        : null,
    };
  }
}
