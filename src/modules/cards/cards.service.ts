import { Injectable, NotFoundException } from '@nestjs/common';
import { FinanceCapabilities } from '../finance/finance-capabilities.service.js';

import type { Card, Transaction } from '@prisma/client';
import { LockType, Prisma } from '@prisma/client';

import { money } from '../../common/money/money.js';
import {
  buildFilterWhere,
  type FilterFieldSpec,
  parseFilterEntries,
} from '../../common/paging/filter.js';
import { parsePaging, toPageResult } from '../../common/paging/paging.js';
import { qWhere } from '../../common/paging/search.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CardAccessService } from './card-access.service.js';

interface PagedOptions {
  page?: number;
  pageSize?: number;
  q?: string;
  filter?: string | string[];
}

const CARD_FILTER_FIELDS: Record<string, FilterFieldSpec> = {
  cardType: { kind: 'enum' },
  status: { kind: 'enum' },
  expirationType: { kind: 'enum' },
};

const CARD_TRANSACTION_FILTER_FIELDS: Record<string, FilterFieldSpec> = {
  status: { kind: 'enum' },
  type: { kind: 'enum' },
  approvalStatus: { kind: 'enum' },
  currency: { kind: 'string' },
};

@Injectable()
export class CardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CardAccessService,
    private readonly capabilities: FinanceCapabilities,
  ) {}

  async list(userId: string, options: PagedOptions = {}) {
    const { page, pageSize, skip, take } = parsePaging(options.page, options.pageSize);
    const where = {
      userId,
      issuer: 'sudo',
      ...buildFilterWhere(parseFilterEntries(options.filter), CARD_FILTER_FIELDS),
      ...qWhere(options.q, ['nickname', 'cardNumberLast4']),
    } as Prisma.CardWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.card.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.card.count({ where }),
    ]);

    return toPageResult(
      await Promise.all(items.map((item) => this.toView(item))),
      total,
      page,
      pageSize,
    );
  }

  async get(userId: string, cardId: string) {
    const card = await this.assertOwnedCard(userId, cardId);
    return this.toView(card);
  }

  async creationAccess(userId: string) {
    const [access, customer] = await Promise.all([
      this.access.summary(userId),
      this.prisma.financeCustomer.findUnique({ where: { userId } }),
    ]);
    const capability = this.capabilities.view();
    return {
      ...access,
      configured: capability.currencies.NGN.enabled,
      customerReady: customer?.status === 'READY',
      issueFee: capability.currencies.NGN.issueFee,
      currency: 'NGN',
    };
  }
  availability(userId: string, id: string) {
    return this.access.cardStatus(userId, id);
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  async listHistory(userId: string, cardId: string) {
    await this.assertOwnedCard(userId, cardId);
    const [history, operations] = await Promise.all([
      this.prisma.cardHistory.findMany({
        where: { cardId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.financeOperation.findMany({
        where: {
          userId,
          cardId,
          kind: { in: ['ISSUE', 'ALLOCATE', 'RETURN'] },
          status: 'SUCCEEDED',
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          kind: true,
          amount: true,
          fee: true,
          currency: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);
    return [
      ...history,
      ...operations.map((op) => ({
        id: op.id,
        cardId,
        event: op.kind === 'ISSUE' ? 'create' : op.kind.toLowerCase(),
        changes: {
          amount: op.amount.toFixed(2),
          fee: op.fee.toFixed(2),
          currency: op.currency,
          status: op.status,
        },
        createdAt: op.createdAt,
      })),
    ]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, 100);
  }

  async listTransactions(userId: string, cardId: string, options: PagedOptions = {}) {
    await this.assertOwnedCard(userId, cardId);
    const { page, pageSize, skip, take } = parsePaging(options.page, options.pageSize);
    const where = {
      userId,
      cardId,
      metadata: { path: ['live'], equals: true },
      ...buildFilterWhere(parseFilterEntries(options.filter), CARD_TRANSACTION_FILTER_FIELDS),
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
      items.map((item) => this.toTransactionView(item)),
      total,
      page,
      pageSize,
    );
  }

  // -------------------------------------------------------------------------
  // Merchant allowlist
  // -------------------------------------------------------------------------

  async listMerchants(userId: string, cardId: string) {
    await this.assertOwnedCard(userId, cardId);
    const lock = await this.prisma.cardLock.findFirst({
      where: { cardId, lockType: 'MERCHANT', isActive: true },
    });
    const ids = (lock?.config as { merchantIds?: string[] } | undefined)?.merchantIds ?? [];
    const rows = await this.prisma.financeAuthorization.findMany({
      where: { userId, merchantId: { in: ids } },
      distinct: ['merchantId'],
      select: { merchantId: true, merchantName: true },
    });
    return rows.map((row) => ({
      id: row.merchantId,
      cardId,
      merchantName: row.merchantName,
      merchantCode: row.merchantId,
      createdAt: lock!.createdAt,
    }));
  }

  async listLocks(userId: string, cardId: string) {
    await this.assertOwnedCard(userId, cardId);
    const locks = await this.prisma.cardLock.findMany({
      where: { cardId },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(
      locks.map(async (lock) => {
        if (lock.lockType !== LockType.SELF_DESTRUCT) return lock;
        const config = lock.config as Record<string, unknown>;
        if (Number.isSafeInteger(config.usageCount) && Number(config.usageCount) >= 0) return lock;
        // Count the full card payment history, independent of UI pagination.
        const usageCount = await this.prisma.financeAuthorization.count({
          where: { userId, cardId, status: { in: ['HELD', 'SETTLED'] } },
        });
        return { ...lock, config: { ...config, usageCount } };
      }),
    );
  }

  async getLock(userId: string, cardId: string, lockId: string) {
    await this.assertOwnedCard(userId, cardId);
    const lock = await this.prisma.cardLock.findFirst({ where: { id: lockId, cardId } });
    if (!lock) throw new NotFoundException('Card lock not found');
    return lock;
  }

  // -------------------------------------------------------------------------
  // Restricted categories
  // -------------------------------------------------------------------------

  async listCategories(userId: string, cardId: string) {
    await this.assertOwnedCard(userId, cardId);
    const lock = await this.prisma.cardLock.findFirst({
      where: { cardId, lockType: 'CATEGORY', isActive: true },
    });
    const categories = (lock?.config as { categories?: string[] } | undefined)?.categories ?? [];
    return categories.map((category) => ({
      id: `${lock!.id}:${category}`,
      cardId,
      category,
      isAllowed: true,
      createdAt: lock!.createdAt,
    }));
  }

  async getCategory(userId: string, cardId: string, id: string) {
    const category = (await this.listCategories(userId, cardId)).find((row) => row.id === id);
    if (!category) throw new NotFoundException('Card category not found');
    return category;
  }

  private async assertOwnedCard(userId: string, cardId: string) {
    const card = await this.prisma.card.findFirst({
      where: { id: cardId, userId, issuer: 'sudo' },
    });
    if (!card) throw new NotFoundException('Card not found');
    return card;
  }

  private async toView(card: Card) {
    const account = await this.prisma.financeAccount.findUnique({
      where: { key: `card:${card.id}:${card.currency}` },
    });
    const { cardNumberEncrypted: _p, cardCvvEncrypted: _c, ...rest } = card;
    return {
      ...rest,
      maxSpendLimit: card.maxSpendLimit === null ? null : money(card.maxSpendLimit),
      monthlyLimit: card.monthlyLimit === null ? null : money(card.monthlyLimit),
      totalSpent: money(card.totalSpent),
      balance: money(account?.balance ?? 0),
    };
  }

  private toTransactionView(transaction: Transaction) {
    const kind = (transaction.metadata as { kind?: string } | null)?.kind;
    return {
      ...transaction,
      isIncoming: transaction.type === 'DEPOSIT' || kind === 'ISSUE' || kind === 'ALLOCATE',
      amount: money(transaction.amount),
    };
  }
}
