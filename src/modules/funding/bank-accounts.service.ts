import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FLUTTERWAVE_CLIENT, type FlutterwaveGateway } from '../flutterwave/flutterwave.client.js';
import { FlutterwaveError } from '../flutterwave/flutterwave.errors.js';

@Injectable()
export class BankAccountsService {
  constructor(
    @Inject(FLUTTERWAVE_CLIENT) private readonly client: FlutterwaveGateway,
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
    try {
      return await this.client.listBanks();
    } catch {
      throw new BadGatewayException('Could not load banks. Please try again.');
    }
  }

  async resolve(bankCode: string, accountNumber: string) {
    try {
      return await this.client.resolveBankAccount(bankCode, accountNumber);
    } catch (error) {
      if (error instanceof FlutterwaveError && error.code === 'VALIDATION') {
        throw new BadRequestException(
          'This account number does not match the selected bank. Check the details and try again.',
        );
      }
      throw new BadGatewayException('Could not verify this bank account. Please try again.');
    }
  }
}
