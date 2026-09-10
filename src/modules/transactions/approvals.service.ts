import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ApprovalStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';

interface PagedOptions {
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Self-service approvals surface. Approvals belong to transactions, so
 * ownership is resolved through the owning user's transactions. Writes expose
 * the approval trail recording to the money-movement flows; `approvedBy` is
 * always the caller.
 */
@Injectable()
export class ApprovalsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, options: PagedOptions & { status?: ApprovalStatus } = {}) {
    const page = options.page ?? 1;
    const pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const where: Prisma.TransactionApprovalWhereInput = {
      transaction: { userId },
      ...(options.status ? { status: options.status } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.transactionApproval.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.transactionApproval.count({ where }),
    ]);

    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  async get(userId: string, approvalId: string) {
    const approval = await this.prisma.transactionApproval.findFirst({
      where: { id: approvalId, transaction: { userId } },
    });
    if (!approval) throw new NotFoundException('Approval not found');
    return approval;
  }

  async create(
    userId: string,
    dto: { transactionId: string; status?: ApprovalStatus; notes?: string },
  ) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id: dto.transactionId, userId },
    });
    if (!transaction) throw new NotFoundException('Transaction not found');

    try {
      return await this.prisma.transactionApproval.create({
        data: {
          id: randomUUID(),
          transactionId: dto.transactionId,
          status: dto.status ?? ApprovalStatus.PENDING,
          approvedBy: userId,
          notes: dto.notes ?? null,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new BadRequestException('The referenced transaction does not exist');
      }
      throw error;
    }
  }

  async update(
    userId: string,
    approvalId: string,
    dto: { status?: ApprovalStatus; notes?: string },
  ) {
    const approval = await this.get(userId, approvalId);
    const data: Prisma.TransactionApprovalUpdateInput = {};
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.notes !== undefined) data.notes = dto.notes;
    return this.prisma.transactionApproval.update({ where: { id: approval.id }, data });
  }

  async remove(userId: string, approvalId: string) {
    const approval = await this.get(userId, approvalId);
    await this.prisma.transactionApproval.delete({ where: { id: approval.id } });
    return { deleted: true as const, id: approval.id };
  }
}
