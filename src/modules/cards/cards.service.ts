import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Card } from '@prisma/client';
import { CardStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { money } from '../../common/money/money.js';
import { PrismaService } from '../../prisma/prisma.service.js';

interface PagedOptions {
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Self-service cards surface. Cards are provisioned by an internal/provider
 * flow (PAN never enters the API here), so creation is out of scope; users can
 * list/detail their own cards and manage lifecycle (pause/resume/limit), the
 * composable locks, and restricted categories.
 */
@Injectable()
export class CardsService {
  constructor(private readonly prisma: PrismaService) {}

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
    const card = await this.prisma.card.findFirst({ where: { id: cardId, userId } });
    if (!card) throw new NotFoundException('Card not found');
    return this.toView(card);
  }

  async pause(userId: string, cardId: string) {
    const card = await this.assertOwnCard(userId, cardId);
    if (card.status === CardStatus.CANCELLED) {
      throw new BadRequestException('Cannot pause a cancelled card');
    }
    const updated = await this.prisma.card.update({
      where: { id: cardId },
      data: { status: CardStatus.PAUSED },
    });
    return this.toView(updated);
  }

  async resume(userId: string, cardId: string) {
    const card = await this.assertOwnCard(userId, cardId);
    if (card.status === CardStatus.CANCELLED) {
      throw new BadRequestException('Cannot resume a cancelled card');
    }
    const updated = await this.prisma.card.update({
      where: { id: cardId },
      data: { status: CardStatus.ACTIVE },
    });
    return this.toView(updated);
  }

  async updateLimit(
    userId: string,
    cardId: string,
    dto: { maxSpendLimit?: string; monthlyLimit?: string },
  ) {
    await this.assertOwnCard(userId, cardId);

    const data: Prisma.CardUpdateInput = {};
    if (dto.maxSpendLimit !== undefined) data.maxSpendLimit = dto.maxSpendLimit;
    if (dto.monthlyLimit !== undefined) data.monthlyLimit = dto.monthlyLimit;
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Provide at least one limit');
    }

    const updated = await this.prisma.card.update({ where: { id: cardId }, data });
    return this.toView(updated);
  }

  // -------------------------------------------------------------------------
  // Locks
  // -------------------------------------------------------------------------

  async listLocks(userId: string, cardId: string) {
    await this.assertOwnCard(userId, cardId);
    return this.prisma.cardLock.findMany({ where: { cardId }, orderBy: { createdAt: 'asc' } });
  }

  async getLock(userId: string, cardId: string, lockId: string) {
    await this.assertOwnCard(userId, cardId);
    const lock = await this.prisma.cardLock.findFirst({ where: { id: lockId, cardId } });
    if (!lock) throw new NotFoundException('Card lock not found');
    return lock;
  }

  async createLock(
    userId: string,
    cardId: string,
    dto: { lockType: string; config?: Record<string, unknown>; isActive?: boolean },
  ) {
    await this.assertOwnCard(userId, cardId);
    try {
      return await this.prisma.cardLock.create({
        data: {
          id: randomUUID(),
          cardId,
          lockType: dto.lockType as never,
          config: (dto.config ?? {}) as Prisma.InputJsonValue,
          isActive: dto.isActive ?? true,
        },
      });
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
    return this.prisma.cardLock.update({ where: { id: lockId }, data });
  }

  async deleteLock(userId: string, cardId: string, lockId: string) {
    await this.getLock(userId, cardId, lockId);
    await this.prisma.cardLock.delete({ where: { id: lockId } });
    return { deleted: true as const, id: lockId };
  }

  // -------------------------------------------------------------------------
  // Restricted categories
  // -------------------------------------------------------------------------

  async listCategories(userId: string, cardId: string) {
    await this.assertOwnCard(userId, cardId);
    return this.prisma.cardCategory.findMany({ where: { cardId }, orderBy: { createdAt: 'asc' } });
  }

  async getCategory(userId: string, cardId: string, categoryId: string) {
    await this.assertOwnCard(userId, cardId);
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
    await this.assertOwnCard(userId, cardId);
    try {
      return await this.prisma.cardCategory.create({
        data: {
          id: randomUUID(),
          cardId,
          category: dto.category as never,
          isAllowed: dto.isAllowed ?? false,
        },
      });
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
    return this.prisma.cardCategory.update({
      where: { id: categoryId },
      data: { isAllowed: dto.isAllowed },
    });
  }

  async deleteCategory(userId: string, cardId: string, categoryId: string) {
    await this.getCategory(userId, cardId, categoryId);
    await this.prisma.cardCategory.delete({ where: { id: categoryId } });
    return { deleted: true as const, id: categoryId };
  }

  private async assertOwnCard(userId: string, cardId: string) {
    const card = await this.prisma.card.findFirst({
      where: { id: cardId, userId },
      select: { id: true, status: true },
    });
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
