import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Transaction } from '@prisma/client';
import { ApprovalStatus, Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { money } from '../../common/money/money.js';
import { parsePaging, toPageResult } from '../../common/paging/paging.js';
import {
  buildFilterWhere,
  type FilterFieldSpec,
  parseFilterEntries,
} from '../../common/paging/filter.js';
import { qWhere } from '../../common/paging/search.js';
import { PrismaService } from '../../prisma/prisma.service.js';

interface PagedOptions {
  page?: number;
  pageSize?: number;
}

interface ListTransactionsOptions extends PagedOptions {
  q?: string;
  filter?: string | string[];
}

const TRANSACTION_FILTER_FIELDS: Record<string, FilterFieldSpec> = {
  status: { kind: 'enum' },
  type: { kind: 'enum' },
  approvalStatus: { kind: 'enum' },
  currency: { kind: 'string' },
  frequency: { kind: 'enum' },
  isRecurring: { kind: 'boolean' },
  thresholdWarning: { kind: 'boolean' },
};

const RECENT_LIMIT = 10;
const RECENT_LIMIT_MAX = 50;

/**
 * Self-service transactions surface. Reads are always available; writes exist
 * so the money-movement flows can record transactions through the API.
 * Recording never touches `wallet.balance` — the movement flow reconciles the
 * wallet separately via `PATCH /api/wallet`.
 */
@Injectable()
export class TransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, options: ListTransactionsOptions = {}) {
    const { page, pageSize, skip, take } = parsePaging(options.page, options.pageSize);
    const where = {
      userId,
      ...buildFilterWhere(parseFilterEntries(options.filter), TRANSACTION_FILTER_FIELDS),
      ...qWhere(options.q, ['description']),
    } as Prisma.TransactionWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return toPageResult(
      items.map((item) => this.toView(item)),
      total,
      page,
      pageSize,
    );
  }

  async recent(userId: string, limit: number = RECENT_LIMIT) {
    const take = Math.min(limit, RECENT_LIMIT_MAX);
    return (
      await this.prisma.transaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take,
      })
    ).map((item) => this.toView(item));
  }

  async get(userId: string, transactionId: string) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id: transactionId, userId },
    });
    if (!transaction) throw new NotFoundException('Transaction not found');
    return this.toView(transaction);
  }

  async create(
    userId: string,
    dto: {
      walletId: string;
      type: TransactionType;
      amount: string;
      status?: TransactionStatus;
      approvalStatus?: ApprovalStatus;
      currency?: string;
      cardId?: string;
      chatId?: string;
      description?: string;
      metadata?: Record<string, unknown>;
      frequency?: string;
      isRecurring?: boolean;
      recurrenceEndDate?: string;
      nextOccurrenceDate?: string;
      approvalNotes?: string;
    },
  ) {
    await this.assertOwnWallet(userId, dto.walletId);
    if (dto.cardId) await this.assertOwnCard(userId, dto.cardId);
    if (dto.chatId) {
      const chat = await this.prisma.chat.findFirst({ where: { id: dto.chatId, userId } });
      if (!chat) throw new NotFoundException('Chat not found');
    }

    try {
      const createTransaction = () =>
        this.prisma.transaction.create({
          data: {
            id: randomUUID(),
            userId,
            walletId: dto.walletId,
            cardId: dto.cardId ?? null,
            chatId: dto.chatId ?? null,
            type: dto.type,
            status: dto.status ?? TransactionStatus.PENDING,
            approvalStatus: dto.approvalStatus ?? ApprovalStatus.PENDING,
            amount: dto.amount,
            currency: dto.currency ?? 'NGN',
            description: dto.description ?? null,
            metadata: (dto.metadata ?? {}) as Prisma.InputJsonValue,
            frequency: (dto.frequency ?? 'ONE_TIME') as never,
            isRecurring: dto.isRecurring ?? false,
            recurrenceEndDate: dto.recurrenceEndDate ?? null,
            nextOccurrenceDate: dto.nextOccurrenceDate ?? null,
            approvalNotes: dto.approvalNotes ?? null,
          },
        });

      const status = dto.status ?? TransactionStatus.PENDING;
      if (
        dto.cardId &&
        dto.type === TransactionType.PAYMENT &&
        status === TransactionStatus.SUCCESS
      ) {
        const [transaction] = await this.prisma.$transaction([
          createTransaction(),
          this.prisma.card.update({
            where: { id: dto.cardId },
            data: { totalSpent: { increment: dto.amount } },
          }),
        ]);
        return this.toView(transaction);
      }
      return this.toView(await createTransaction());
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new BadRequestException('Referenced wallet, card, or chat does not exist');
      }
      throw error;
    }
  }

  async update(
    userId: string,
    transactionId: string,
    dto: {
      status?: TransactionStatus;
      approvalStatus?: ApprovalStatus;
      amount?: string;
      currency?: string;
      description?: string;
      metadata?: Record<string, unknown>;
      frequency?: string;
      isRecurring?: boolean;
      recurrenceEndDate?: string;
      nextOccurrenceDate?: string;
      approvalNotes?: string;
      thresholdWarning?: boolean;
    },
  ) {
    const current = await this.prisma.transaction.findFirst({
      where: { id: transactionId, userId },
    });
    if (!current) throw new NotFoundException('Transaction not found');
    const data: Prisma.TransactionUpdateInput = {};
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.approvalStatus !== undefined) data.approvalStatus = dto.approvalStatus;
    if (dto.amount !== undefined) data.amount = dto.amount;
    if (dto.currency !== undefined) data.currency = dto.currency;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.metadata !== undefined) data.metadata = dto.metadata as Prisma.InputJsonValue;
    if (dto.frequency !== undefined) data.frequency = dto.frequency as never;
    if (dto.isRecurring !== undefined) data.isRecurring = dto.isRecurring;
    if (dto.recurrenceEndDate !== undefined) data.recurrenceEndDate = dto.recurrenceEndDate;
    if (dto.nextOccurrenceDate !== undefined) data.nextOccurrenceDate = dto.nextOccurrenceDate;
    if (dto.approvalNotes !== undefined) data.approvalNotes = dto.approvalNotes;
    if (dto.thresholdWarning !== undefined) data.thresholdWarning = dto.thresholdWarning;

    const nextStatus = dto.status ?? current.status;
    const nextAmount = dto.amount !== undefined ? new Prisma.Decimal(dto.amount) : current.amount;
    const countedBefore = this.isSpendCounted(current);
    const countedAfter =
      current.type === TransactionType.PAYMENT && nextStatus === TransactionStatus.SUCCESS;
    const delta = this.spendDelta(countedBefore, countedAfter, current.amount, nextAmount);

    const updateTransaction = () =>
      this.prisma.transaction.update({ where: { id: transactionId }, data });

    let updated: Transaction;
    if (current.cardId && !delta.isZero()) {
      [updated] = await this.prisma.$transaction([
        updateTransaction(),
        this.prisma.card.update({
          where: { id: current.cardId },
          data: { totalSpent: { increment: delta } },
        }),
      ]);
    } else {
      updated = await updateTransaction();
    }
    return this.toView(updated);
  }

  async remove(userId: string, transactionId: string) {
    const current = await this.prisma.transaction.findFirst({
      where: { id: transactionId, userId },
    });
    if (!current) throw new NotFoundException('Transaction not found');
    if (current.cardId && this.isSpendCounted(current)) {
      await this.prisma.$transaction([
        this.prisma.transaction.delete({ where: { id: transactionId } }),
        this.prisma.card.update({
          where: { id: current.cardId },
          data: { totalSpent: { decrement: current.amount } },
        }),
      ]);
    } else {
      await this.prisma.transaction.delete({ where: { id: transactionId } });
    }
    return { deleted: true as const, id: transactionId };
  }

  private isSpendCounted(transaction: Pick<Transaction, 'type' | 'status'>) {
    return (
      transaction.type === TransactionType.PAYMENT &&
      transaction.status === TransactionStatus.SUCCESS
    );
  }

  /** Signed delta for `card.totalSpent` between a pre- and post-update state. */
  private spendDelta(
    countedBefore: boolean,
    countedAfter: boolean,
    beforeAmount: Transaction['amount'],
    afterAmount: Prisma.Decimal,
  ) {
    if (!countedBefore && !countedAfter) return new Prisma.Decimal(0);
    if (countedBefore && !countedAfter) return new Prisma.Decimal(0).minus(beforeAmount);
    if (!countedBefore && countedAfter) return new Prisma.Decimal(afterAmount);
    return afterAmount.minus(beforeAmount);
  }

  private async assertOwnWallet(userId: string, walletId: string) {
    const wallet = await this.prisma.wallet.findFirst({
      where: { id: walletId, account: { userId } },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');
  }

  private async assertOwnCard(userId: string, cardId: string) {
    const card = await this.prisma.card.findFirst({ where: { id: cardId, userId } });
    if (!card) throw new NotFoundException('Card not found');
  }

  private toView(transaction: Transaction) {
    return { ...transaction, amount: money(transaction.amount) };
  }
}
