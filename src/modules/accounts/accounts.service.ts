import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}
  async get(userId: string) {
    const account = await this.prisma.account.findUnique({ where: { userId } });
    if (!account) throw new NotFoundException('Account not found');
    const customer = await this.prisma.financeCustomer.findUnique({ where: { userId } });
    return { ...account, accountNumber: customer?.bankAccountNumber ?? '' };
  }
}
