import { Injectable } from '@nestjs/common';
import { AccountType, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { generateLuhnAccountNumber } from '../../accounts/account-number.js';

export interface ProvisionedAccount {
  accountId: string;
  walletId: string;
  accountNumber: string;
}

/**
 * Idempotent account provisioning: flips the profile to verified and, the first
 * time it sees a user, opens their single checking account + wallet in one
 * transaction. Shared by email verification (auth) and invite acceptance, so a
 * user can never end up verified-but-unprovisioned or vice versa.
 */
@Injectable()
export class UserProvisioningService {
  constructor(private readonly prisma: PrismaService) {}

  async provision(userId: string): Promise<ProvisionedAccount | undefined> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.profile.update({
          where: { id: userId },
          data: { emailVerified: true },
        });

        const existing = await tx.account.findUnique({
          where: { userId },
          select: { id: true },
        });
        if (existing) return undefined;

        const account = await tx.account.create({
          data: {
            id: randomUUID(),
            userId,
            accountNumber: generateLuhnAccountNumber(),
            accountType: AccountType.CHECKING,
          },
        });
        const wallet = await tx.wallet.create({
          data: { id: randomUUID(), accountId: account.id },
        });
        return { accountId: account.id, walletId: wallet.id, accountNumber: account.accountNumber };
      });
    } catch (error) {
      // A concurrent provisioning run won the race: the user is already set up.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return undefined;
      }
      throw error;
    }
  }
}
