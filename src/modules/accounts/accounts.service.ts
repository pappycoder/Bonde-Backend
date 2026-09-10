import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { generateLuhnAccountNumber } from './account-number.js';

/**
 * Self-service account surface. A user holds exactly one account (enforced by
 * the unique `Account.userId`). Reads return 404 until provisioned; writes are
 * exposed so internal onboarding/money flows can provision and manage it via
 * the API.
 */
@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string) {
    const account = await this.prisma.account.findUnique({ where: { userId } });
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  async create(
    userId: string,
    dto: { accountNumber?: string; accountType?: string; isActive?: boolean },
  ) {
    try {
      return await this.prisma.account.create({
        data: {
          id: randomUUID(),
          userId,
          accountNumber: dto.accountNumber ?? generateLuhnAccountNumber(),
          accountType: dto.accountType ?? 'checking',
          isActive: dto.isActive ?? true,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(
          'An account already exists for this user or this account number',
        );
      }
      throw error;
    }
  }

  async update(userId: string, dto: { accountType?: string; isActive?: boolean }) {
    await this.get(userId);
    const data: Prisma.AccountUpdateInput = {};
    if (dto.accountType !== undefined) data.accountType = dto.accountType;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    return this.prisma.account.update({ where: { userId }, data });
  }

  async remove(userId: string) {
    const account = await this.get(userId);
    await this.prisma.account.delete({ where: { userId } });
    return { deleted: true as const, id: account.id };
  }
}
