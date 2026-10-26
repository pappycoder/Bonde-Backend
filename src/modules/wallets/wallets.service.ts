import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FinanceService } from '../finance/finance.service.js';

/** Presentation metadata comes from Wallet; all money comes from the ledger. */
@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly finance: FinanceService,
  ) {}
  async get(userId: string) {
    const wallet = await this.prisma.wallet.findFirst({
      where: { account: { userId } },
      include: { account: true },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');
    const balances = await this.finance.wallets(userId);
    const balance = balances.find((row) => row.currency === 'NGN');
    const { account, ...metadata } = wallet;
    return {
      ...metadata,
      currency: 'NGN',
      balance: balance?.balance ?? '0.00',
      allocated: balance?.allocated ?? '0.00',
      held: balance?.held ?? '0.00',
      isActive: wallet.isActive && account.isActive,
      live: true,
    };
  }
}
