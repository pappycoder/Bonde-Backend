import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Wallet } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { money } from '../../common/money/money.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Self-service wallet surface. A wallet is linked 1:1 to the user's single
 * account, so lookups resolve through the account's `userId`. Balance is
 * reconciled by the money-movement flows via `update`.
 */
@Injectable()
export class WalletsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string) {
    const wallet = await this.prisma.wallet.findFirst({
      where: { account: { userId } },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');
    return this.toView(wallet);
  }

  async create(userId: string, dto: { balance?: string; currency?: string; isActive?: boolean }) {
    const account = await this.prisma.account.findUnique({ where: { userId } });
    if (!account) throw new NotFoundException('Account not found');

    try {
      const wallet = await this.prisma.wallet.create({
        data: {
          id: randomUUID(),
          accountId: account.id,
          balance: dto.balance ?? '0',
          currency: dto.currency ?? 'NGN',
          isActive: dto.isActive ?? true,
        },
      });
      return this.toView(wallet);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          throw new ConflictException('A wallet already exists for this account');
        }
        if (error.code === 'P2003') {
          throw new BadRequestException('The referenced account does not exist');
        }
      }
      throw error;
    }
  }

  async update(userId: string, dto: { balance?: string; currency?: string; isActive?: boolean }) {
    const wallet = await this.get(userId);
    const data: Prisma.WalletUpdateInput = {};
    if (dto.balance !== undefined) data.balance = dto.balance;
    if (dto.currency !== undefined) data.currency = dto.currency;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    const updated = await this.prisma.wallet.update({ where: { id: wallet.id }, data });
    return this.toView(updated);
  }

  async remove(userId: string) {
    const wallet = await this.get(userId);
    try {
      await this.prisma.wallet.delete({ where: { id: wallet.id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new BadRequestException('Cannot delete a wallet that still has transactions');
      }
      throw error;
    }
    return { deleted: true as const, id: wallet.id };
  }

  private toView(wallet: Wallet) {
    return { ...wallet, balance: money(wallet.balance) };
  }
}
