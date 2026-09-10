import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { TransactionThreshold } from '@prisma/client';
import { Prisma } from '@prisma/client';
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
 * Self-service transaction thresholds. A user may configure one threshold per
 * type (unique `userId + thresholdType`), toggling the warning rules on their
 * own transactions.
 */
@Injectable()
export class ThresholdsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, options: PagedOptions = {}) {
    const page = options.page ?? 1;
    const pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const where: Prisma.TransactionThresholdWhereInput = { userId };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.transactionThreshold.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.transactionThreshold.count({ where }),
    ]);

    return {
      items: items.map((item) => this.toView(item)),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async get(userId: string, thresholdId: string) {
    const threshold = await this.prisma.transactionThreshold.findFirst({
      where: { id: thresholdId, userId },
    });
    if (!threshold) throw new NotFoundException('Threshold not found');
    return this.toView(threshold);
  }

  async create(
    userId: string,
    dto: { thresholdType: string; thresholdValue: string; isActive?: boolean },
  ) {
    try {
      const threshold = await this.prisma.transactionThreshold.create({
        data: {
          id: randomUUID(),
          userId,
          thresholdType: dto.thresholdType as never,
          thresholdValue: dto.thresholdValue,
          isActive: dto.isActive ?? true,
        },
      });
      return this.toView(threshold);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A threshold of this type already exists');
      }
      throw error;
    }
  }

  async update(
    userId: string,
    thresholdId: string,
    dto: { thresholdValue?: string; isActive?: boolean },
  ) {
    await this.get(userId, thresholdId);
    const data: Prisma.TransactionThresholdUpdateInput = {};
    if (dto.thresholdValue !== undefined) data.thresholdValue = dto.thresholdValue;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    const threshold = await this.prisma.transactionThreshold.update({
      where: { id: thresholdId },
      data,
    });
    return this.toView(threshold);
  }

  async remove(userId: string, thresholdId: string) {
    await this.get(userId, thresholdId);
    await this.prisma.transactionThreshold.delete({ where: { id: thresholdId } });
    return { deleted: true as const, id: thresholdId };
  }

  private toView(threshold: TransactionThreshold) {
    return { ...threshold, thresholdValue: money(threshold.thresholdValue) };
  }
}
