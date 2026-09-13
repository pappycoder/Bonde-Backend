import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NotificationStatus, NotificationType, Prisma } from '@prisma/client';
import { parsePaging, toPageResult } from '../../common/paging/paging.js';
import {
  buildFilterWhere,
  type FilterFieldSpec,
  parseFilterEntries,
} from '../../common/paging/filter.js';
import { qWhere } from '../../common/paging/search.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface CreateNotificationInput {
  targetUserId: string;
  title: string;
  content: string;
  type?: NotificationType;
  metadata?: Prisma.InputJsonValue;
}

export interface ListNotificationsOptions {
  q?: string;
  filter?: string | string[];
  page?: number;
  pageSize?: number;
}

const NOTIFICATION_FILTER_FIELDS: Record<string, FilterFieldSpec> = {
  status: { kind: 'enum' },
  type: { kind: 'enum' },
};

/**
 * In-app notifications for the authenticated user. `create` is the internal
 * write path for other features (cards, transactions, chat, ...); the public
 * surface is read + mark-read only. Admin-side management of notifications is
 * available through the generic admin CRUD surface.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateNotificationInput): Promise<void> {
    await this.prisma.notification.create({
      data: {
        id: randomUUID(),
        userId: input.targetUserId,
        title: input.title,
        content: input.content,
        type: input.type ?? NotificationType.SYSTEM,
        metadata: input.metadata ?? undefined,
      },
    });
  }

  async list(userId: string, options: ListNotificationsOptions = {}) {
    const { page, pageSize, skip, take } = parsePaging(options.page, options.pageSize);
    const where = {
      userId,
      ...buildFilterWhere(parseFilterEntries(options.filter), NOTIFICATION_FILTER_FIELDS),
      ...qWhere(options.q, ['title', 'content']),
    } as Prisma.NotificationWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return toPageResult(items, total, page, pageSize);
  }

  async markRead(userId: string, notificationId: string): Promise<unknown> {
    const existing = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { id: true, userId: true },
    });
    if (!existing || existing.userId !== userId) {
      throw new NotFoundException('Notification not found');
    }
    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { status: NotificationStatus.READ, readAt: new Date() },
    });
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, status: NotificationStatus.UNREAD },
      data: { status: NotificationStatus.READ, readAt: new Date() },
    });
    return { updated: result.count };
  }
}
