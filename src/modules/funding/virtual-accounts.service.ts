import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Inject } from '@nestjs/common';
import { VirtualAccountStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FLUTTERWAVE_CLIENT, type FlutterwaveGateway } from '../flutterwave/flutterwave.client.js';
import { throwFlutterwaveHttp } from '../flutterwave/flutterwave.errors.js';
import type { DepositAccountView } from './funding.types.js';

const DYNAMIC_VA_NARRATION = 'Bonde wallet funding';

/**
 * Per-user deposit accounts. Every user resolves to a current ACTIVE dynamic
 * virtual account (reused until it expires, then a fresh one is minted).
 *
 * Static/permanent VAs require the customer's BVN/NIN, which the app does not
 * collect today — `mint(..., { permanent })` is the seam; once a Profile
 * carries encrypted identity, callers can opt into a permanent VA there.
 */
@Injectable()
export class VirtualAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(FLUTTERWAVE_CLIENT) private readonly client: FlutterwaveGateway,
  ) {}

  async getDepositAccount(userId: string): Promise<DepositAccountView> {
    const profile = await this.prisma.profile.findUnique({ where: { id: userId } });
    if (!profile) throw new NotFoundException('Profile not found');

    const currency = 'NGN';
    const current = await this.prisma.virtualAccount.findFirst({
      where: { userId, currency, status: VirtualAccountStatus.ACTIVE, isPermanent: false },
    });
    if (current && this.isYetActive(current.expiresAt)) {
      return this.toView(current);
    }
    // The expired one is marked, then a fresh account is minted + persisted.
    if (current) {
      await this.prisma.virtualAccount.update({
        where: { id: current.id },
        data: { status: VirtualAccountStatus.EXPIRED },
      });
    }

    const permanent = false; // requires BVN/NIN on the profile — not collected yet.
    const txRef = `bonde_va_${randomUUID()}`;
    try {
      const [first, lastName = ''] = profile.fullName.trim().split(/\s+/);
      const va = await this.client.createVirtualAccount({
        email: profile.email,
        isPermanent: permanent,
        txRef,
        bankCode: this.config.get('flutterwave').vaBankCode,
        currency,
        firstName: first,
        lastName,
        narration: DYNAMIC_VA_NARRATION,
      });
      const row = await this.prisma.virtualAccount.create({
        data: {
          id: randomUUID(),
          userId,
          provider: 'flutterwave',
          providerReference: String(va.id),
          txRef,
          accountNumber: va.accountNumber,
          bankName: va.bankName,
          accountName: va.accountName ?? null,
          currency,
          status: VirtualAccountStatus.ACTIVE,
          isPermanent: permanent,
          expiresAt: va.expiryDate ? new Date(va.expiryDate) : null,
          meta: { orderRef: va.orderRef },
        },
      });
      return this.toView(row);
    } catch (error) {
      throwFlutterwaveHttp(error);
    }
  }

  private isYetActive(expiresAt: Date | null): boolean {
    return expiresAt === null || expiresAt.getTime() > Date.now();
  }

  private toView(row: {
    accountNumber: string;
    bankName: string;
    accountName: string | null;
    currency: string;
    isPermanent: boolean;
    expiresAt: Date | null;
  }): DepositAccountView {
    return {
      accountNumber: row.accountNumber,
      bankName: row.bankName,
      accountName: row.accountName,
      currency: row.currency,
      isPermanent: row.isPermanent,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    };
  }
}
