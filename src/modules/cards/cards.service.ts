import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Card, Transaction } from '@prisma/client';
import { CardStatus, LockType, Prisma } from '@prisma/client';
import { randomInt, randomUUID } from 'node:crypto';
import { decrypt, encrypt } from '../../common/crypto/aes-gcm.js';
import { AppConfig } from '../../config/configuration.js';
import { money } from '../../common/money/money.js';
import { parsePaging, toPageResult } from '../../common/paging/paging.js';
import {
  buildFilterWhere,
  type FilterFieldSpec,
  parseFilterEntries,
} from '../../common/paging/filter.js';
import { qWhere } from '../../common/paging/search.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { generateLuhnPan, last4 } from './card-number.js';
import type { UpdateCardRulesDto } from './cards.dto.js';

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

interface WriteDto {
  nickname?: string;
  cardType?: string;
  maxSpendLimit?: string;
  monthlyLimit?: string;
  allowTopUp?: boolean;
  notifyHalfSpent?: boolean;
  notifyLowBalance?: boolean;
  notifyBudgetReached?: boolean;
}

function defaultExpiration(expirationType: string, from: Date = new Date()): Date {
  const days = expirationType === 'yearly' ? 365 : 30;
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Self-service cards surface. Users create their own cards here (PAN is
 * generated + AES-256-GCM encrypted server-side and never returned), manage
 * lifecycle and the composable locks / restricted categories / merchant
 * allowlist, and read the per-card change timeline (`card_history`).
 */
@Injectable()
export class CardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async list(userId: string, options: PagedOptions = {}) {
    const { page, pageSize, skip, take } = parsePaging(options.page, options.pageSize);
    const where = {
      userId,
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
      items.map((item) => this.toView(item)),
      total,
      page,
      pageSize,
    );
  }

  async get(userId: string, cardId: string) {
    const card = await this.assertOwnedCard(userId, cardId);
    return this.toView(card);
  }

  /** Sensitive credentials are only available through this owned-card read. */
  async credentials(userId: string, cardId: string) {
    let card = await this.assertOwnedCard(userId, cardId);
    if (
      !card.cardCvvEncrypted &&
      card.issuer === 'bonde' &&
      this.config.get('nodeEnv', { infer: true }) === 'development'
    ) {
      // Older local development cards predate CVV storage. Persist one once;
      // a concurrent reader reuses the value written by the winning request.
      const encryptedCvv = this.encrypt(randomInt(1000).toString().padStart(3, '0'));
      const updated = await this.prisma.card.updateMany({
        where: { id: cardId, userId, issuer: 'bonde', cardCvvEncrypted: null },
        data: { cardCvvEncrypted: encryptedCvv },
      });
      card =
        updated.count > 0
          ? { ...card, cardCvvEncrypted: encryptedCvv }
          : await this.assertOwnedCard(userId, cardId);
    }
    const key = this.config.get('encryption.cardKey', { infer: true });
    return {
      cardNumber: decrypt(card.cardNumberEncrypted, key),
      cvv: card.cardCvvEncrypted ? decrypt(card.cardCvvEncrypted, key) : null,
    };
  }

  async create(
    userId: string,
    dto: {
      cardType?: string;
      nickname?: string;
      maxSpendLimit?: string;
      monthlyLimit?: string;
      allowTopUp?: boolean;
      notifyHalfSpent?: boolean;
      notifyLowBalance?: boolean;
      notifyBudgetReached?: boolean;
      expirationType?: string;
      expirationDate?: string;
    },
  ) {
    // TODO: Remove dev fallback once a real card provider is configured in production.
    let provider = await this.prisma.cardProvider.findFirst({ where: { isActive: true } });
    if (!provider && this.config.get('nodeEnv', { infer: true }) === 'development') {
      // This record only satisfies the local card's foreign key; it never
      // represents a live issuer. Keep it inactive so other environments and
      // provider-issued card flows cannot pick it as an active provider.
      provider = await this.prisma.cardProvider.upsert({
        where: { name: 'Bonde Development' },
        create: {
          id: randomUUID(),
          name: 'Bonde Development',
          baseUrl: 'http://localhost',
          isActive: false,
          config: { developmentOnly: true },
        },
        update: {},
      });
    }
    if (!provider) throw new NotFoundException('No card provider is configured');

    const pan = generateLuhnPan();
    const card = await this.prisma.card.create({
      data: {
        id: randomUUID(),
        userId,
        providerId: provider.id,
        cardNumberEncrypted: this.encrypt(pan),
        cardCvvEncrypted:
          this.config.get('nodeEnv', { infer: true }) === 'development'
            ? this.encrypt(randomInt(1000).toString().padStart(3, '0'))
            : null,
        cardNumberLast4: last4(pan),
        cardType: dto.cardType ?? 'virtual',
        nickname: dto.nickname?.trim() || null,
        maxSpendLimit: dto.maxSpendLimit ? money(dto.maxSpendLimit) : null,
        monthlyLimit: dto.monthlyLimit ? money(dto.monthlyLimit) : null,
        allowTopUp: dto.allowTopUp ?? true,
        notifyHalfSpent: dto.notifyHalfSpent ?? true,
        notifyLowBalance: dto.notifyLowBalance ?? true,
        notifyBudgetReached: dto.notifyBudgetReached ?? true,
        expirationType: dto.expirationType ?? 'monthly',
        expirationDate: dto.expirationDate
          ? new Date(dto.expirationDate)
          : defaultExpiration(dto.expirationType ?? 'monthly'),
      },
    });
    await this.recordHistory(card.id, 'create', {});
    return this.toView(card);
  }

  async update(userId: string, cardId: string, dto: WriteDto) {
    return this.applyUpdate(userId, cardId, dto, 'update');
  }

  async updateRules(userId: string, cardId: string, dto: UpdateCardRulesDto) {
    return this.prisma.$transaction(async (tx) => {
      const card = await tx.card.findFirst({ where: { id: cardId, userId } });
      if (!card) throw new NotFoundException('Card not found');
      if (card.status === CardStatus.CANCELLED) {
        throw new BadRequestException('Cannot update a cancelled card');
      }
      const locks = await tx.cardLock.findMany({ where: { cardId } });
      const lock = dto.lock ? locks.find((entry) => entry.id === dto.lock!.id) : undefined;
      if (dto.lock && (!lock || !lock.isActive)) {
        throw new BadRequestException('The rule is not active on this card');
      }
      const config = dto.lock?.config;
      if (lock && config) {
        if (lock.lockType === LockType.SELF_DESTRUCT) {
          if (!Number.isSafeInteger(config.usageLimit) || Number(config.usageLimit) < 1) {
            throw new BadRequestException('Usage limit must be a positive integer');
          }
        }
        if (lock.lockType === LockType.TIME) {
          const start = typeof config.start === 'string' ? Date.parse(config.start) : NaN;
          const end = typeof config.end === 'string' ? Date.parse(config.end) : NaN;
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
            throw new BadRequestException('Provide a valid start and end time');
          }
        }
        if (
          lock.lockType === LockType.BUDGET &&
          (typeof config.monthlyLimit !== 'string' || config.monthlyLimit !== dto.monthlyLimit)
        ) {
          throw new BadRequestException('Budget rule must match the card monthly limit');
        }
      }
      const activeTypes = new Set(
        locks.filter((entry) => entry.isActive).map((entry) => entry.lockType),
      );
      if (
        [LockType.SELF_DESTRUCT, LockType.MERCHANT, LockType.TIME, LockType.CATEGORY].some((type) =>
          activeTypes.has(type),
        ) &&
        Number(dto.maxSpendLimit ?? card.maxSpendLimit) <= 0
      ) {
        throw new BadRequestException('Maximum spending limit is required');
      }
      for (const value of [dto.maxSpendLimit, dto.monthlyLimit]) {
        if (value !== undefined && (!/^\d+(\.\d{1,2})?$/.test(value) || Number(value) <= 0)) {
          throw new BadRequestException('Spending limits must be positive decimal amounts');
        }
      }
      if (activeTypes.has(LockType.BUDGET) && Number(dto.monthlyLimit ?? card.monthlyLimit) <= 0) {
        throw new BadRequestException('Monthly budget is required');
      }
      if (dto.merchants !== undefined && !activeTypes.has(LockType.MERCHANT)) {
        throw new BadRequestException('This card has no active merchant rule');
      }
      if (dto.categories !== undefined && !activeTypes.has(LockType.CATEGORY)) {
        throw new BadRequestException('This card has no active category rule');
      }
      const names = dto.merchants?.map((merchant) => merchant.merchantName.trim());
      if (
        names &&
        (!names.length || names.some((name) => !name) || new Set(names).size !== names.length)
      ) {
        throw new BadRequestException('Provide distinct, non-empty allowed merchants');
      }
      if (dto.categories && !dto.categories.length) {
        throw new BadRequestException('Select at least one allowed category');
      }

      const data: Prisma.CardUpdateInput = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const key of [
        'nickname',
        'maxSpendLimit',
        'monthlyLimit',
        'allowTopUp',
        'notifyHalfSpent',
        'notifyLowBalance',
        'notifyBudgetReached',
      ] as const) {
        if (dto[key] === undefined) continue;
        const value = key === 'nickname' ? dto.nickname!.trim() || null : dto[key];
        before[key] =
          key === 'maxSpendLimit' || key === 'monthlyLimit'
            ? card[key] === null
              ? null
              : money(card[key]!)
            : card[key];
        after[key] = value;
        Object.assign(data, {
          [key]: key === 'maxSpendLimit' || key === 'monthlyLimit' ? money(value as string) : value,
        });
      }
      if (dto.cardType !== undefined)
        throw new BadRequestException('Card type cannot be changed when editing rules');
      if (!Object.keys(data).length && !dto.lock && !dto.merchants && !dto.categories) {
        throw new BadRequestException('Provide at least one change');
      }
      if (!Object.keys(data).length) data.updatedAt = new Date();
      if (lock && config) {
        before.lock = { id: lock.id, config: lock.config };
        const editableKeys =
          lock.lockType === LockType.SELF_DESTRUCT
            ? ['usageLimit']
            : lock.lockType === LockType.TIME
              ? ['start', 'end']
              : lock.lockType === LockType.BUDGET
                ? ['monthlyLimit']
                : [];
        const editableConfig = Object.fromEntries(
          Object.entries(config).filter(([key]) => editableKeys.includes(key)),
        );
        const merged = { ...(lock.config as Record<string, unknown>), ...editableConfig };
        after.lock = { id: lock.id, config: merged };
        await tx.cardLock.update({
          where: { id: lock.id },
          data: { config: merged as Prisma.InputJsonValue },
        });
      }
      if (dto.merchants && names) {
        const existing = await tx.cardMerchant.findMany({ where: { cardId } });
        before.merchants = existing.map((merchant) => merchant.merchantName);
        after.merchants = names;
        await tx.cardMerchant.deleteMany({ where: { cardId, merchantName: { notIn: names } } });
        for (const merchant of dto.merchants) {
          const merchantName = merchant.merchantName.trim();
          if (!existing.some((entry) => entry.merchantName === merchantName)) {
            await tx.cardMerchant.create({
              data: { id: randomUUID(), cardId, merchantName, merchantCode: merchant.merchantCode },
            });
          }
        }
      }
      if (dto.categories) {
        const existing = await tx.cardCategory.findMany({ where: { cardId, isAllowed: true } });
        before.categories = existing.map((entry) => entry.category);
        after.categories = dto.categories;
        await tx.cardCategory.deleteMany({
          where: { cardId, isAllowed: true, category: { notIn: dto.categories } },
        });
        for (const category of dto.categories) {
          await tx.cardCategory.upsert({
            where: { cardId_category: { cardId, category } },
            create: { id: randomUUID(), cardId, category, isAllowed: true },
            update: { isAllowed: true },
          });
        }
      }
      const result = await tx.card.updateMany({
        where: { id: cardId, userId, status: { not: CardStatus.CANCELLED } },
        data,
      });
      if (result.count !== 1) throw new BadRequestException('Card is no longer editable');
      await tx.cardHistory.create({
        data: {
          id: randomUUID(),
          cardId,
          event: 'rules.update',
          changes: { before, after, currency: card.currency } as Prisma.InputJsonValue,
        },
      });
      const updated = await tx.card.findFirstOrThrow({ where: { id: cardId, userId } });
      return this.toView(updated);
    });
  }

  async pause(userId: string, cardId: string) {
    const card = await this.assertOwnedCard(userId, cardId);
    if (card.status === CardStatus.CANCELLED) {
      throw new BadRequestException('Cannot pause a cancelled card');
    }
    const updated = await this.prisma.card.update({
      where: { id: cardId },
      data: { status: CardStatus.PAUSED },
    });
    await this.recordHistory(cardId, 'pause');
    return this.toView(updated);
  }

  async resume(userId: string, cardId: string) {
    const card = await this.assertOwnedCard(userId, cardId);
    if (card.status === CardStatus.CANCELLED) {
      throw new BadRequestException('Cannot resume a cancelled card');
    }
    const updated = await this.prisma.card.update({
      where: { id: cardId },
      data: { status: CardStatus.ACTIVE },
    });
    await this.recordHistory(cardId, 'resume');
    return this.toView(updated);
  }

  async updateLimit(
    userId: string,
    cardId: string,
    dto: { maxSpendLimit?: string; monthlyLimit?: string },
  ) {
    return this.applyUpdate(userId, cardId, dto, 'limit');
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  async listHistory(userId: string, cardId: string) {
    await this.assertOwnedCard(userId, cardId);
    return this.prisma.cardHistory.findMany({
      where: { cardId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listTransactions(userId: string, cardId: string, options: PagedOptions = {}) {
    await this.assertOwnedCard(userId, cardId);
    const { page, pageSize, skip, take } = parsePaging(options.page, options.pageSize);
    const where = {
      userId,
      cardId,
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
    return this.prisma.cardMerchant.findMany({ where: { cardId }, orderBy: { createdAt: 'asc' } });
  }

  async addMerchant(
    userId: string,
    cardId: string,
    dto: { merchantName: string; merchantCode?: string },
  ) {
    await this.assertOwnedCard(userId, cardId);
    const name = dto.merchantName.trim();
    if (!name) throw new BadRequestException('merchantName must not be empty');
    const code = dto.merchantCode?.trim() || null;

    if (!code) {
      const existing = await this.prisma.cardMerchant.findFirst({
        where: { cardId, merchantName: { equals: name, mode: 'insensitive' } },
      });
      if (existing) throw new ConflictException('This merchant is already allowlisted');
    }

    try {
      const merchant = await this.prisma.cardMerchant.create({
        data: { id: randomUUID(), cardId, merchantName: name, merchantCode: code },
      });
      await this.recordHistory(cardId, 'merchant.add', {
        merchant: { merchantName: name, merchantCode: code },
      });
      return merchant;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('This merchant is already allowlisted');
      }
      throw error;
    }
  }

  async removeMerchant(userId: string, cardId: string, merchantId: string) {
    await this.assertOwnedCard(userId, cardId);
    const merchant = await this.prisma.cardMerchant.findFirst({
      where: { id: merchantId, cardId },
    });
    if (!merchant) throw new NotFoundException('Card merchant not found');
    await this.prisma.cardMerchant.delete({ where: { id: merchantId } });
    await this.recordHistory(cardId, 'merchant.remove', {
      merchant: { merchantName: merchant.merchantName, merchantCode: merchant.merchantCode },
    });
    return { deleted: true as const, id: merchantId };
  }

  // -------------------------------------------------------------------------
  // Locks
  // -------------------------------------------------------------------------

  async listLocks(userId: string, cardId: string) {
    await this.assertOwnedCard(userId, cardId);
    return this.prisma.cardLock.findMany({ where: { cardId }, orderBy: { createdAt: 'asc' } });
  }

  async getLock(userId: string, cardId: string, lockId: string) {
    await this.assertOwnedCard(userId, cardId);
    const lock = await this.prisma.cardLock.findFirst({ where: { id: lockId, cardId } });
    if (!lock) throw new NotFoundException('Card lock not found');
    return lock;
  }

  async createLock(
    userId: string,
    cardId: string,
    dto: { lockType: string; config?: Record<string, unknown>; isActive?: boolean },
  ) {
    await this.assertOwnedCard(userId, cardId);
    try {
      const lock = await this.prisma.cardLock.create({
        data: {
          id: randomUUID(),
          cardId,
          lockType: dto.lockType as never,
          config: (dto.config ?? {}) as Prisma.InputJsonValue,
          isActive: dto.isActive ?? true,
        },
      });
      await this.recordHistory(cardId, 'lock.create', {
        lock: { lockType: lock.lockType, lockId: lock.id },
      });
      return lock;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A lock of this type already exists on this card');
      }
      throw error;
    }
  }

  async updateLock(
    userId: string,
    cardId: string,
    lockId: string,
    dto: { config?: Record<string, unknown>; isActive?: boolean },
  ) {
    await this.getLock(userId, cardId, lockId);
    const data: Prisma.CardLockUpdateInput = {};
    if (dto.config !== undefined) data.config = dto.config as Prisma.InputJsonValue;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Provide at least one field');
    }
    const lock = await this.prisma.cardLock.update({ where: { id: lockId }, data });
    await this.recordHistory(cardId, 'lock.update', { lockId });
    return lock;
  }

  async deleteLock(userId: string, cardId: string, lockId: string) {
    await this.getLock(userId, cardId, lockId);
    await this.prisma.cardLock.delete({ where: { id: lockId } });
    await this.recordHistory(cardId, 'lock.delete', { lockId });
    return { deleted: true as const, id: lockId };
  }

  // -------------------------------------------------------------------------
  // Restricted categories
  // -------------------------------------------------------------------------

  async listCategories(userId: string, cardId: string) {
    await this.assertOwnedCard(userId, cardId);
    return this.prisma.cardCategory.findMany({ where: { cardId }, orderBy: { createdAt: 'asc' } });
  }

  async getCategory(userId: string, cardId: string, categoryId: string) {
    await this.assertOwnedCard(userId, cardId);
    const category = await this.prisma.cardCategory.findFirst({
      where: { id: categoryId, cardId },
    });
    if (!category) throw new NotFoundException('Card category not found');
    return category;
  }

  async createCategory(
    userId: string,
    cardId: string,
    dto: { category: string; isAllowed?: boolean },
  ) {
    await this.assertOwnedCard(userId, cardId);
    try {
      const category = await this.prisma.cardCategory.create({
        data: {
          id: randomUUID(),
          cardId,
          category: dto.category as never,
          isAllowed: dto.isAllowed ?? false,
        },
      });
      await this.recordHistory(cardId, 'category.create', {
        category: { category: category.category, categoryId: category.id },
      });
      return category;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('This category is already configured on the card');
      }
      throw error;
    }
  }

  async updateCategory(
    userId: string,
    cardId: string,
    categoryId: string,
    dto: { isAllowed: boolean },
  ) {
    await this.getCategory(userId, cardId, categoryId);
    const category = await this.prisma.cardCategory.update({
      where: { id: categoryId },
      data: { isAllowed: dto.isAllowed },
    });
    await this.recordHistory(cardId, 'category.update', { categoryId, category });
    return category;
  }

  async deleteCategory(userId: string, cardId: string, categoryId: string) {
    await this.getCategory(userId, cardId, categoryId);
    await this.prisma.cardCategory.delete({ where: { id: categoryId } });
    await this.recordHistory(cardId, 'category.delete', { categoryId });
    return { deleted: true as const, id: categoryId };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async applyUpdate(userId: string, cardId: string, dto: WriteDto, event: string) {
    const card = await this.assertOwnedCard(userId, cardId);
    if (card.status === CardStatus.CANCELLED) {
      throw new BadRequestException('Cannot update a cancelled card');
    }

    const data: Prisma.CardUpdateInput = {};
    if (dto.nickname !== undefined) data.nickname = dto.nickname.trim() || null;
    if (dto.cardType !== undefined) data.cardType = dto.cardType;
    if (dto.maxSpendLimit !== undefined) data.maxSpendLimit = money(dto.maxSpendLimit);
    if (dto.monthlyLimit !== undefined) data.monthlyLimit = money(dto.monthlyLimit);
    if (dto.allowTopUp !== undefined) data.allowTopUp = dto.allowTopUp;
    if (dto.notifyHalfSpent !== undefined) data.notifyHalfSpent = dto.notifyHalfSpent;
    if (dto.notifyLowBalance !== undefined) data.notifyLowBalance = dto.notifyLowBalance;
    if (dto.notifyBudgetReached !== undefined) data.notifyBudgetReached = dto.notifyBudgetReached;
    if (Object.keys(data).length === 0) {
      throw new BadRequestException(
        event === 'limit' ? 'Provide at least one limit' : 'Provide at least one field',
      );
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of Object.keys(data)) {
      before[key] = card[key as keyof Card];
      after[key] = data[key as keyof Prisma.CardUpdateInput];
    }

    const updated = await this.prisma.card.update({ where: { id: cardId }, data });
    await this.recordHistory(cardId, event, { before, after, currency: card.currency });
    return this.toView(updated);
  }

  private async recordHistory(
    cardId: string,
    event: string,
    changes: Record<string, unknown> = {},
  ): Promise<void> {
    await this.prisma.cardHistory.create({
      data: {
        id: randomUUID(),
        cardId,
        event,
        changes: changes as Prisma.InputJsonValue,
      },
    });
  }

  private encrypt(pan: string): string {
    return encrypt(pan, this.config.get('encryption.cardKey', { infer: true }));
  }

  private async assertOwnedCard(userId: string, cardId: string) {
    const card = await this.prisma.card.findFirst({ where: { id: cardId, userId } });
    if (!card) throw new NotFoundException('Card not found');
    return card;
  }

  private toView(card: Card) {
    const { cardNumberEncrypted: _p, cardCvvEncrypted: _c, ...rest } = card;
    return {
      ...rest,
      maxSpendLimit: card.maxSpendLimit === null ? null : money(card.maxSpendLimit),
      monthlyLimit: card.monthlyLimit === null ? null : money(card.monthlyLimit),
      totalSpent: money(card.totalSpent),
      balance: money(card.balance),
    };
  }

  private toTransactionView(transaction: Transaction) {
    return { ...transaction, amount: money(transaction.amount) };
  }
}
