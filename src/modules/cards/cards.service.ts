import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Card } from '@prisma/client';
import { CardStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { encrypt } from '../../common/crypto/aes-gcm.js';
import { AppConfig } from '../../config/configuration.js';
import { money } from '../../common/money/money.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { generateLuhnPan, last4 } from './card-number.js';

interface PagedOptions {
  page?: number;
  pageSize?: number;
}

interface WriteDto {
  nickname?: string;
  cardType?: string;
  maxSpendLimit?: string;
  monthlyLimit?: string;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

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
    const page = options.page ?? 1;
    const pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const where: Prisma.CardWhereInput = { userId };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.card.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.card.count({ where }),
    ]);

    return {
      items: items.map((item) => this.toView(item)),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async get(userId: string, cardId: string) {
    const card = await this.assertOwnedCard(userId, cardId);
    return this.toView(card);
  }

  async create(
    userId: string,
    dto: {
      cardType?: string;
      nickname?: string;
      maxSpendLimit?: string;
      monthlyLimit?: string;
      expirationType?: string;
      expirationDate?: string;
    },
  ) {
    const provider = await this.prisma.cardProvider.findFirst({ where: { isActive: true } });
    if (!provider) throw new NotFoundException('No card provider is configured');

    const pan = generateLuhnPan();
    const card = await this.prisma.card.create({
      data: {
        id: randomUUID(),
        userId,
        providerId: provider.id,
        cardNumberEncrypted: this.encrypt(pan),
        cardNumberLast4: last4(pan),
        cardType: dto.cardType ?? 'virtual',
        nickname: dto.nickname?.trim() || null,
        maxSpendLimit: dto.maxSpendLimit ? money(dto.maxSpendLimit) : null,
        monthlyLimit: dto.monthlyLimit ? money(dto.monthlyLimit) : null,
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
    await this.recordHistory(cardId, event, { before, after });
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
    const { cardNumberEncrypted: _encrypted, ...rest } = card;
    return {
      ...rest,
      maxSpendLimit: card.maxSpendLimit === null ? null : money(card.maxSpendLimit),
      monthlyLimit: card.monthlyLimit === null ? null : money(card.monthlyLimit),
    };
  }
}
