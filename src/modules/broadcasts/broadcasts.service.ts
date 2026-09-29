import { BadRequestException, Injectable } from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { parsePaging, toPageResult } from '../../common/paging/paging.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit-log.service.js';
import type { ListBroadcastsQuery, SendBroadcastDto } from './broadcasts.dto.js';

/** `createMany` is chunked so a large audience never builds one huge statement. */
const INSERT_CHUNK = 1000;

export interface BroadcastView {
  id: string;
  title: string;
  body: string;
  recipientCount: number;
  sentBy: string | null;
  senderName: string | null;
  createdAt: string;
}

@Injectable()
export class BroadcastsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Fans an admin message out to every active profile as an in-app
   * `Notification` row, synchronously. **In-app only**: unlike
   * `NotificationsService.create` this deliberately skips the push dispatcher,
   * so a broadcast never fans out to a device or an inbox.
   *
   * "Active" = `emailVerified: true` — a profile that finished registration and
   * owns an account. In-flight signups are skipped.
   */
  async send(dto: SendBroadcastDto, sentBy: string) {
    const recipients = await this.prisma.profile.findMany({
      where: { emailVerified: true },
      select: { id: true },
    });
    if (recipients.length === 0) throw new BadRequestException('No active recipients');

    const broadcastId = randomUUID();
    const now = new Date();
    const rows = recipients.map((recipient) => ({
      id: randomUUID(),
      userId: recipient.id,
      title: dto.title,
      content: dto.body,
      type: NotificationType.SYSTEM,
      metadata: { broadcastId, source: 'admin-broadcast' } as Prisma.InputJsonValue,
      createdAt: now,
    }));

    // One statement per chunk, all inside a single transaction: a broadcast is
    // never half-delivered, and the send record lands with the copies.
    const chunks: Prisma.PrismaPromise<unknown>[] = [];
    for (let index = 0; index < rows.length; index += INSERT_CHUNK) {
      chunks.push(
        this.prisma.notification.createMany({
          data: rows.slice(index, index + INSERT_CHUNK),
          skipDuplicates: true,
        }),
      );
    }
    chunks.push(
      this.prisma.broadcast.create({
        data: {
          id: broadcastId,
          title: dto.title,
          body: dto.body,
          recipientCount: rows.length,
          sentBy,
        },
      }) as Prisma.PrismaPromise<unknown>,
    );
    await this.prisma.$transaction(chunks);

    await this.audit.record({
      userId: sentBy,
      action: 'admin.broadcast.send',
      entityType: 'broadcast',
      entityId: broadcastId,
      metadata: { title: dto.title, recipientCount: rows.length },
    });

    return {
      id: broadcastId,
      title: dto.title,
      recipientCount: rows.length,
      sentAt: now.toISOString(),
      status: 'sent' as const,
    };
  }

  async list(query: ListBroadcastsQuery) {
    const { page, pageSize, skip, take } = parsePaging(query.page, query.pageSize);
    const where: Prisma.BroadcastWhereInput = query.q
      ? {
          OR: [
            { title: { contains: query.q, mode: 'insensitive' } },
            { body: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {};

    const [items, total] = await this.prisma.$transaction([
      this.prisma.broadcast.findMany({
        where,
        include: { sender: { select: { fullName: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.broadcast.count({ where }),
    ]);

    return toPageResult(
      items.map((broadcast) => this.toView(broadcast)),
      total,
      page,
      pageSize,
    );
  }

  private toView(broadcast: {
    id: string;
    title: string;
    body: string;
    recipientCount: number;
    sentBy: string | null;
    createdAt: Date;
    sender: { fullName: string } | null;
  }): BroadcastView {
    return {
      id: broadcast.id,
      title: broadcast.title,
      body: broadcast.body,
      recipientCount: broadcast.recipientCount,
      sentBy: broadcast.sentBy,
      senderName: broadcast.sender?.fullName ?? null,
      createdAt: broadcast.createdAt.toISOString(),
    };
  }
}
