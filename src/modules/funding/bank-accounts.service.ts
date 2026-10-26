import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FinanceCapabilities } from '../finance/finance-capabilities.service.js';
import { SafeHavenClient, object, string } from '../finance/providers.js';

@Injectable()
export class BankAccountsService {
  constructor(
    private readonly client: SafeHavenClient,
    private readonly capabilities: FinanceCapabilities,
    private readonly prisma: PrismaService,
  ) {}

  saved(userId: string) {
    return this.prisma.withdrawalBankAccount.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: this.select,
    });
  }

  async save(userId: string, bankCode: string, accountNumber: string) {
    const bank = (await this.list()).find((bank) => bank.code === bankCode);
    if (!bank) throw new BadRequestException('Choose a supported bank');
    const verified = await this.resolve(bankCode, accountNumber);
    const fields = {
      bankName: bank.name,
      accountName: verified.accountName,
      verifiedAt: new Date(),
    };
    return this.prisma.withdrawalBankAccount.upsert({
      where: { userId_bankCode_accountNumber: { userId, bankCode, accountNumber } },
      create: { id: randomUUID(), userId, bankCode, accountNumber, ...fields },
      update: fields,
      select: this.select,
    });
  }

  async remove(userId: string, id: string) {
    const result = await this.prisma.withdrawalBankAccount.deleteMany({ where: { id, userId } });
    if (!result.count) throw new NotFoundException('Saved bank account not found');
    return { deleted: true as const, id };
  }

  private readonly select = {
    id: true,
    bankCode: true,
    bankName: true,
    accountNumber: true,
    accountName: true,
    verifiedAt: true,
    createdAt: true,
  } as const;

  async list() {
    this.capabilities.assertCurrency('NGN');
    const data = await this.client.banks();
    if (!Array.isArray(data)) throw new ServiceUnavailableException('Could not load banks');
    return data.map((value) => {
      const bank = object(value);
      return { name: string(bank.name), code: string(bank.bankCode ?? bank.code) };
    });
  }

  async resolve(bankCode: string, accountNumber: string) {
    this.capabilities.assertCurrency('NGN');
    const data = object(await this.client.resolve(bankCode, accountNumber));
    const accountName = string(data.accountName);
    if (!accountName) throw new BadRequestException('Could not verify this bank account');
    return { accountName, accountNumber };
  }
}
