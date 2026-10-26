import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FinanceCapabilities } from './finance-capabilities.service.js';
import { SafeHavenClient, SudoClient, object, string, ProviderError } from './providers.js';
import type {
  FinanceBankCompleteDto,
  FinanceBankIdentityDto,
  FinanceIdentityDto,
} from './finance.dto.js';

@Injectable()
export class FinanceIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly safe: SafeHavenClient,
    private readonly sudo: SudoClient,
    private readonly capabilities: FinanceCapabilities,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}
  private digest(type: string, number: string) {
    return createHmac('sha256', this.config.get('kyc').hashSecret)
      .update(`${type}:${number}`)
      .digest('hex');
  }
  private async profile(userId: string) {
    this.capabilities.assertCurrency('NGN');
    const p = await this.prisma.profile.findUniqueOrThrow({ where: { id: userId } });
    if (!p.emailVerified || !p.phoneVerified || !p.phone)
      throw new BadRequestException('Verify your email and phone first');
    return p;
  }
  async initiate(userId: string, dto: FinanceBankIdentityDto) {
    await this.profile(userId);
    const existing = await this.prisma.financeCustomer.findUnique({ where: { userId } });
    if (existing?.bankStatus === 'READY' || existing?.bankStatus === 'PROCESSING')
      throw new ConflictException('Bank setup is already complete or processing');
    const data = object(
      await this.safe.call('/identity/v2', 'POST', {
        type: dto.identityType,
        number: dto.identityNumber,
        debitAccountNumber: this.config.get('finance').treasuryAccountNumber,
        async: false,
      }),
    );
    const identityId = string(data._id);
    await this.prisma.financeCustomer.upsert({
      where: { userId },
      create: {
        userId,
        identityRef: identityId,
        identityHash: this.digest(dto.identityType, dto.identityNumber),
      },
      update: {
        identityRef: identityId,
        identityHash: this.digest(dto.identityType, dto.identityNumber),
      },
    });
    return { identityId };
  }
  async completeBank(userId: string, dto: FinanceBankCompleteDto) {
    const profile = await this.profile(userId);
    const customer = await this.prisma.financeCustomer.findUnique({ where: { userId } });
    if (
      !customer ||
      customer.identityRef !== dto.identityId ||
      customer.identityHash !== this.digest(dto.identityType, dto.identityNumber)
    )
      throw new BadRequestException('Restart identity verification');
    if (customer.bankAccountId) return { completed: true };
    const claim = await this.prisma.financeCustomer.updateMany({
      where: { userId, bankStatus: 'PENDING' },
      data: { bankStatus: 'PROCESSING' },
    });
    if (!claim.count)
      throw new ConflictException(
        'Bank setup is already processing; support can reconcile an uncertain result',
      );
    try {
      const bank = object(
        await this.safe.call('/accounts/v2/subaccount', 'POST', {
          phoneNumber: profile.phone,
          emailAddress: profile.email,
          externalReference: `bonde:${userId}`,
          identityType: dto.identityType,
          identityNumber: dto.identityNumber,
          identityId: dto.identityId,
          otp: dto.otp,
          autoSweep: false,
        }),
      );
      await this.prisma.$transaction(async (tx) => {
        await tx.financeCustomer.update({
          where: { userId },
          data: {
            bankAccountId: string(bank._id),
            bankAccountNumber: string(bank.accountNumber),
            bankAccountName: string(bank.accountName),
            bankCode: this.config.get('finance').safeHavenBankCode,
            bankStatus: 'READY',
            status: customer.sudoId ? 'READY' : 'PENDING',
          },
        });
        const identity =
          dto.identityType === 'BVN'
            ? {
                bvnHash: this.digest(dto.identityType, dto.identityNumber),
                bvnVerifiedAt: new Date(),
              }
            : {
                ninHash: this.digest(dto.identityType, dto.identityNumber),
                ninVerifiedAt: new Date(),
              };
        await tx.kycVerification.upsert({
          where: { userId },
          create: {
            id: randomUUID(),
            userId,
            provider: 'safe-haven',
            status: 'VERIFIED',
            ...identity,
            providerRef: { bankIdentityId: dto.identityId },
          },
          update: {
            provider: 'safe-haven',
            status: 'VERIFIED',
            ...identity,
            providerRef: { bankIdentityId: dto.identityId },
          },
        });
      });
      return { completed: true };
    } catch (error) {
      if (error instanceof ProviderError && error.definitive)
        await this.prisma.financeCustomer.update({
          where: { userId },
          data: { bankStatus: 'PENDING' },
        });
      throw new ServiceUnavailableException(
        'Bank setup could not be confirmed. Refresh before retrying.',
      );
    }
  }
  async cardholder(userId: string, dto: FinanceIdentityDto) {
    const profile = await this.profile(userId);
    const customer = await this.prisma.financeCustomer.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    if (customer.sudoId) return { completed: true };
    if (
      !dto.firstName.trim() ||
      !dto.lastName.trim() ||
      !Number.isFinite(Date.parse(dto.dob)) ||
      new Date(dto.dob) >= new Date()
    )
      throw new BadRequestException('Valid legal identity details are required');
    const claim = await this.prisma.financeCustomer.updateMany({
      where: { userId, sudoStatus: 'PENDING' },
      data: { sudoStatus: 'PROCESSING' },
    });
    if (!claim.count)
      throw new ConflictException(
        'Cardholder setup is already processing; support can reconcile an uncertain result',
      );
    try {
      const result = object(
        await this.sudo.call('/customers', 'POST', {
          type: 'individual',
          name: `${dto.firstName} ${dto.lastName}`,
          phoneNumber: profile.phone,
          emailAddress: profile.email,
          status: 'active',
          billingAddress: {
            line1: dto.line1,
            city: dto.city,
            state: dto.state,
            postalCode: dto.postalCode,
            country: 'NG',
          },
          individual: {
            firstName: dto.firstName,
            lastName: dto.lastName,
            dob: dto.dob,
            identity: { type: dto.identityType, number: dto.identityNumber },
          },
          metadata: { bondeUserId: userId },
        }),
      );
      await this.prisma.financeCustomer.update({
        where: { userId },
        data: {
          sudoId: string(result._id),
          sudoStatus: 'READY',
          status: customer.bankAccountId ? 'READY' : 'PENDING',
        },
      });
      return { completed: true };
    } catch (error) {
      if (error instanceof ProviderError && error.definitive)
        await this.prisma.financeCustomer.update({
          where: { userId },
          data: { sudoStatus: 'PENDING' },
        });
      throw new ServiceUnavailableException(
        'Cardholder setup could not be confirmed. Refresh before retrying.',
      );
    }
  }
}
