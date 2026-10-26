import { Injectable, NotFoundException } from '@nestjs/common';
import type { Transaction } from '@prisma/client';
import { Prisma } from '@prisma/client';

import { money } from '../../common/money/money.js';
import {
  buildFilterWhere,
  type FilterFieldSpec,
  parseFilterEntries,
} from '../../common/paging/filter.js';
import { parsePaging, toPageResult } from '../../common/paging/paging.js';
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

/** Read-only presentation of live financial transaction projections. */
@Injectable()
export class TransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, options: ListTransactionsOptions = {}) {
    const { page, pageSize, skip, take } = parsePaging(options.page, options.pageSize);
    const where = {
      userId,
      metadata: { path: ['live'], equals: true },
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
        where: { userId, metadata: { path: ['live'], equals: true } },
        orderBy: { createdAt: 'desc' },
        take,
      })
    ).map((item) => this.toView(item));
  }

  async get(userId: string, transactionId: string) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id: transactionId, userId, metadata: { path: ['live'], equals: true } },
    });
    if (!transaction) throw new NotFoundException('Transaction not found');
    return this.toView(transaction);
  }

  private toView(transaction: Transaction) {
    return {
      ...transaction,
      isIncoming:
        transaction.type === 'DEPOSIT' ||
        (transaction.metadata as { direction?: string } | null)?.direction === 'CREDIT',
      amount: money(transaction.amount),
    };
  }
}
