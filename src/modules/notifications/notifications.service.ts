import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
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
import type { PushDispatcher } from './push-dispatcher.interface.js';
import {
  NoopPushDispatcher,
  PUSH_DISPATCHER,
} from './push-dispatcher.interface.js';

export interface CreateNotificationInput {
  targetUserId: string;
  title: string;
  content: string;
  type?: NotificationType;
  metadata?: Prisma.InputJsonValue;
}

export interface RegisterDeviceInput {
  userId: string;
  token: string;
  platform: 'ANDROID' | 'IOS';
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

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(PUSH_DISPATCHER)
    private readonly push: PushDispatcher = new NoopPushDispatcher(),
  ) {}

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

    // Best-effort push — in-app is source of truth; push must never fail the
    // request that produced the notification (mirrors MAIL/OTP convention).
    await this.dispatchBestEffort(input.targetUserId, input.title, input.content);
  }

  async registerDevice(input: RegisterDeviceInput): Promise<void> {
    await this.prisma.pushDevice.upsert({
      where: { token: input.token },
      create: {
        id: randomUUID(),
        userId: input.userId,
        token: input.token,
        platform: input.platform,
      },
      update: { userId: input.userId, platform: input.platform },
    });
  }

  async unregisterDevice(userId: string, token: string): Promise<{ removed: number }> {
    const result = await this.prisma.pushDevice.deleteMany({
      where: { token, userId },
    });
    return { removed: result.count };
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

  private async dispatchBestEffort(
    userId: string,
    title: string,
    content: string,
  ): Promise<void> {
    if (!this.push.isEnabled()) return;
    const devices = await this.prisma.pushDevice.findMany({
      where: { userId },
      select: { token: true },
    });
    await Promise.allSettled(
      devices.map((d) =>
        this.push.send({ deviceToken: d.token, title, body: content }),
      ),
    );
  }
}
