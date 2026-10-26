import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { money } from '../../common/money/money.js';
import {
  buildFilterWhere,
  parseFilterEntries,
  type FilterFieldSpec,
} from '../../common/paging/filter.js';
import { parsePaging, toPageResult } from '../../common/paging/paging.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { walletKey } from '../finance/finance.types.js';
import { toAdminTxSummary, type UiTxStatus } from './admin-tx-view.js';

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
  uiStatus?: UiTxStatus;
}

/**
 * Prisma predicate for a UI-legible status: the exact preimage of
 * `deriveTxStatus`, so a `uiStatus` filter returns precisely the rows that
 * render with that badge. `approvalStatus` is non-nullable and
 * `thresholdWarning` defaults to false, so equality is safe.
 *
 * The disjunctions are nested under `AND` rather than placed at the top level,
 * because `buildWhere` merges this with a free-text `q` whose own `OR` would
 * otherwise overwrite them.
 */
export function uiStatusWhere(uiStatus: UiTxStatus): Prisma.TransactionWhereInput {
  switch (uiStatus) {
    case 'completed':
      return { status: 'SUCCESS', thresholdWarning: false };
    case 'processing':
      return { status: 'PENDING', approvalStatus: 'PENDING', thresholdWarning: false };
    case 'pending':
      return { status: 'PENDING', approvalStatus: 'APPROVED', thresholdWarning: false };
    case 'failed':
      // FAIL short-circuits first; a decline leaves the row PENDING.
      return {
        AND: [{ OR: [{ status: 'FAIL' }, { status: 'PENDING', approvalStatus: 'DECLINED' }] }],
      };
    case 'flagged':
      // A warning flags anything that is not already failed, and a decline
      // beats the warning.
      return {
        AND: [
          {
            thresholdWarning: true,
            OR: [{ status: 'SUCCESS' }, { status: 'PENDING', approvalStatus: { not: 'DECLINED' } }],
          },
        ],
      };
  }
}

/**
 * Admin surface over the full ledger. `q` searches the transaction description
 * or the owning user's name/email; `filter` accepts the raw `type`/`status`/
 * `approvalStatus` enums and boolean flags. Phase 3 adds the review decision:
 * an admin records an APPROVED/DECLINED approval (append-only trail) and the
 * transaction's `approvalStatus`/`approvedAt` follow it, both in one write.
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
            balance: money(
              (
                await this.prisma.financeAccount.findUnique({
                  where: { key: walletKey(transaction.userId, transaction.currency) },
                })
              )?.balance ?? 0,
            ),
            currency: transaction.currency,
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
      ...(options.uiStatus ? uiStatusWhere(options.uiStatus) : {}),
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
