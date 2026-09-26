import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { parsePaging, toPageResult } from '../../common/paging/paging.js';
import { AuditLogService } from '../audit/audit-log.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type AdminSupportStatus = 'OPEN' | 'PENDING' | 'RESOLVED';
export type AdminSupportPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

const MAX_MSG_LEN = 4000;

const TICKET_INCLUDE = {
  user: { select: { id: true, fullName: true, email: true } },
  assignee: { select: { fullName: true } },
  _count: { select: { messages: true } },
} as const satisfies Prisma.SupportTicketInclude;

type TicketRow = Prisma.SupportTicketGetPayload<{ include: typeof TICKET_INCLUDE }>;

export interface AdminSupportListOptions {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: AdminSupportStatus;
}

/**
 * Admin surface over `support_tickets` + `support_messages`. Tickets carry a
 * USER/SUPPORT conversation; admins read them, reply (SUPPORT role), move
 * their status, and can raise a ticket on a user's behalf. All transitions are
 * audited (`admin.support.*`) and — like suspend/restore and reviews — are
 * admin-only actions, so nothing here notifies end users automatically.
 */
@Injectable()
export class AdminConsoleSupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async list(options: AdminSupportListOptions = {}) {
    const { page, pageSize, skip, take } = parsePaging(options.page, options.pageSize);
    const where = this.buildWhere(options);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.supportTicket.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take,
        include: TICKET_INCLUDE,
      }),
      this.prisma.supportTicket.count({ where }),
    ]);

    return toPageResult(
      items.map((item) => this.toView(item)),
      total,
      page,
      pageSize,
    );
  }

  async get(ticketId: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        ...TICKET_INCLUDE,
        messages: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, role: true, body: true, createdAt: true },
        },
      },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');

    return {
      ...this.toView(ticket),
      messages: ticket.messages.map((message) => ({
        id: message.id,
        role: message.role,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      })),
    };
  }

  /** Raise a ticket for a user (admin-on-behalf-of), optionally with the first message. */
  async create(
    actorUserId: string,
    dto: { userId: string; subject: string; priority?: AdminSupportPriority; message?: string },
  ) {
    const user = await this.prisma.profile.findUnique({
      where: { id: dto.userId },
      select: { id: true },
    });
    if (!user) throw new BadRequestException('User not found');

    const ticketId = randomUUID();
    await this.prisma.$transaction([
      this.prisma.supportTicket.create({
        data: {
          id: ticketId,
          userId: dto.userId,
          subject: dto.subject,
          ...(dto.priority ? { priority: dto.priority } : {}),
        },
      }),
      ...(dto.message
        ? [
            this.prisma.supportMessage.create({
              data: { id: randomUUID(), ticketId, role: 'USER', body: dto.message },
            }),
          ]
        : []),
    ]);

    await this.audit.record({
      userId: actorUserId,
      action: 'admin.support.create',
      entityType: 'support-ticket',
      entityId: ticketId,
      metadata: { subject: dto.subject },
    });

    return this.get(ticketId);
  }

  /** Append a SUPPORT message and touch the ticket so `updatedAt` stays current. */
  async reply(ticketId: string, actorUserId: string, body: string) {
    if (body.length > MAX_MSG_LEN) {
      throw new BadRequestException('Reply is too long');
    }
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, status: true },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.status === 'RESOLVED') {
      throw new ConflictException('Resolved tickets cannot receive new messages');
    }

    await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: { id: randomUUID(), ticketId, role: 'SUPPORT', body },
      }),
      this.prisma.supportTicket.update({
        where: { id: ticketId },
        data: { updatedAt: new Date() },
      }),
    ]);

    await this.audit.record({
      userId: actorUserId,
      action: 'admin.support.reply',
      entityType: 'support-ticket',
      entityId: ticketId,
    });

    return this.get(ticketId);
  }

  /** Move the ticket between OPEN/PENDING/RESOLVED. Idempotent no-op, audited. */
  async changeStatus(ticketId: string, actorUserId: string, status: AdminSupportStatus) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, status: true },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.status !== status) {
      await this.prisma.supportTicket.update({
        where: { id: ticketId },
        data: { status },
      });
      await this.audit.record({
        userId: actorUserId,
        action: 'admin.support.status',
        entityType: 'support-ticket',
        entityId: ticketId,
        metadata: { from: ticket.status, to: status },
      });
    }
    return this.get(ticketId);
  }

  private buildWhere(options: AdminSupportListOptions): Prisma.SupportTicketWhereInput {
    return {
      ...(options.status ? { status: options.status } : {}),
      ...this.searchWhere(options.q),
    };
  }

  private searchWhere(q?: string): Prisma.SupportTicketWhereInput {
    const term = q?.trim();
    if (!term) return {};
    return {
      OR: [
        { subject: { contains: term, mode: 'insensitive' } },
        { user: { fullName: { contains: term, mode: 'insensitive' } } },
        { user: { email: { contains: term, mode: 'insensitive' } } },
      ],
    };
  }

  private toView(ticket: TicketRow) {
    return {
      id: ticket.id,
      userId: ticket.userId,
      user: ticket.user?.fullName ?? null,
      userEmail: ticket.user?.email ?? null,
      subject: ticket.subject,
      priority: ticket.priority,
      status: ticket.status,
      assignee: ticket.assignee?.fullName ?? null,
      messageCount: ticket._count.messages,
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(),
    };
  }
}
