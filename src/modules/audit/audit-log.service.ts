import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { parsePaging, toPageResult } from '../../common/paging/paging.js';
import {
  buildFilterWhere,
  type FilterFieldSpec,
  parseFilterEntries,
} from '../../common/paging/filter.js';
import { qWhere } from '../../common/paging/search.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const ENTITY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PagedOptions {
  page?: number;
  pageSize?: number;
  q?: string;
  filter?: string | string[];
}

const AUDIT_LOG_FILTER_FIELDS: Record<string, FilterFieldSpec> = {
  action: { kind: 'string' },
  entityType: { kind: 'string' },
};

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
    const { page, pageSize, skip, take } = parsePaging(options.page, options.pageSize);
    const where = {
      userId,
      ...buildFilterWhere(parseFilterEntries(options.filter), AUDIT_LOG_FILTER_FIELDS),
      ...qWhere(options.q, ['action', 'entityType']),
    } as Prisma.AuditLogWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return toPageResult(items, total, page, pageSize);
  }

  /** Read of one of the caller's own entries. */
  async getForUser(userId: string, logId: string) {
    const entry = await this.prisma.auditLog.findFirst({ where: { id: logId, userId } });
    if (!entry) throw new NotFoundException('Audit log not found');
    return entry;
  }
}
