import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

const ENTITY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PagedOptions {
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface AuditLogEntryInput {
  /** Actor. `null`/omitted for system actions. */
  userId?: string | null;
  /** Short verb, e.g. `profile.update`, `otp.verify`. */
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Append-only audit trail. Modules call `record(...)` after security-relevant
 * writes (profile changes, OTP verification, admin CRUD mutations). Rows are
 * immutable by design — there is intentionally no update/delete here, and the
 * admin CRUD surface exposes audit logs as read-only.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditLogEntryInput): Promise<void> {
    this.validate(input);
    await this.prisma.auditLog.create({
      data: {
        id: randomUUID(),
        userId: input.userId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: input.metadata ?? undefined,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  private validate(input: AuditLogEntryInput): void {
    if (!input.action.trim() || input.action.length > 100) {
      throw new BadRequestException('Audit "action" must be 1-100 characters');
    }
    if (!input.entityType.trim() || input.entityType.length > 50) {
      throw new BadRequestException('Audit "entityType" must be 1-50 characters');
    }
    if (!ENTITY_UUID.test(input.entityId)) {
      throw new BadRequestException('Audit "entityId" must be a UUID');
    }
  }

  /** Paged read of the caller's own entries (self-service surface). */
  async listForUser(userId: string, options: PagedOptions = {}) {
    const page = options.page ?? 1;
    const pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const where: Prisma.AuditLogWhereInput = { userId };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  /** Read of one of the caller's own entries. */
  async getForUser(userId: string, logId: string) {
    const entry = await this.prisma.auditLog.findFirst({ where: { id: logId, userId } });
    if (!entry) throw new NotFoundException('Audit log not found');
    return entry;
  }
}
