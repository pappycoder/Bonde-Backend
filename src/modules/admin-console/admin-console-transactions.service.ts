import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { money } from '../../common/money/money.js';
import { parsePaging, toPageResult } from '../../common/paging/paging.js';
import {
  buildFilterWhere,
  parseFilterEntries,
  type FilterFieldSpec,
} from '../../common/paging/filter.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { toAdminTxSummary } from './admin-tx-view.js';

const TX_FILTER_FIELDS: Record<string, FilterFieldSpec> = {
  type: { kind: 'enum' },
  status: { kind: 'enum' },
  approvalStatus: { kind: 'enum' },
  thresholdWarning: { kind: 'boolean' },
  isRecurring: { kind: 'boolean' },
};

const TX_LIST_INCLUDE = {
  user: { select: { fullName: true, email: true } },
  wallet: { select: { currency: true } },
  card: { select: { cardNumberLast4: true } },
} as const satisfies Prisma.TransactionInclude;

type TxListRow = Prisma.TransactionGetPayload<{ include: typeof TX_LIST_INCLUDE }>;

export interface AdminTransactionsListOptions {
  page?: number;
  pageSize?: number;
  q?: string;
  filter?: string | string[];
}

/**
 * Read-only admin surface over the full ledger. `q` searches the transaction
 * description or the owning user's name/email; `filter` accepts the raw
 * `type`/`status`/`approvalStatus` enums and boolean flags.
 */
@Injectable()
export class AdminConsoleTransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(options: AdminTransactionsListOptions = {}) {
    const { page, pageSize, skip, take } = parsePaging(options.page, options.pageSize);
    const where = this.buildWhere(options);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: TX_LIST_INCLUDE,
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

  async get(transactionId: string) {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        user: { select: { id: true, fullName: true, email: true } },
        wallet: true,
        card: {
          select: {
            id: true,
            cardNumberLast4: true,
            cardType: true,
            status: true,
            createdAt: true,
          },
        },
        approvals: {
          orderBy: { createdAt: 'desc' },
          include: { approver: { select: { id: true, fullName: true } } },
        },
        providerEvents: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            provider: true,
            reference: true,
            eventType: true,
            status: true,
            processedAt: true,
            createdAt: true,
          },
        },
      },
    });
    if (!transaction) throw new NotFoundException('Transaction not found');

    return {
      ...this.toView(transaction),
      wallet: transaction.wallet
        ? {
            id: transaction.wallet.id,
            balance: money(transaction.wallet.balance),
            currency: transaction.wallet.currency,
            isActive: transaction.wallet.isActive,
          }
        : null,
      card: transaction.card
        ? { ...transaction.card, createdAt: transaction.card.createdAt.toISOString() }
        : null,
      approvals: transaction.approvals.map((approval) => ({
        id: approval.id,
        status: approval.status,
        approvedBy: approval.approvedBy,
        approver: approval.approver?.fullName ?? null,
        notes: approval.notes,
        createdAt: approval.createdAt.toISOString(),
      })),
      providerEvents: transaction.providerEvents.map((event) => ({
        id: event.id,
        provider: event.provider,
        reference: event.reference,
        eventType: event.eventType,
        status: event.status,
        processedAt: event.processedAt ? event.processedAt.toISOString() : null,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  private buildWhere(options: AdminTransactionsListOptions): Prisma.TransactionWhereInput {
    return {
      ...buildFilterWhere(parseFilterEntries(options.filter), TX_FILTER_FIELDS),
      ...this.searchWhere(options.q),
    };
  }

  private searchWhere(q?: string): Prisma.TransactionWhereInput {
    const term = q?.trim();
    if (!term) return {};
    return {
      OR: [
        { description: { contains: term, mode: 'insensitive' } },
        { user: { fullName: { contains: term, mode: 'insensitive' } } },
        { user: { email: { contains: term, mode: 'insensitive' } } },
      ],
    };
  }

  private toView(transaction: TxListRow) {
    return {
      ...toAdminTxSummary(transaction, transaction.wallet?.currency),
      user: transaction.user?.fullName ?? null,
      userEmail: transaction.user?.email ?? null,
    };
  }
}
