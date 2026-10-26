import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SafeHavenClient, SudoClient, object, string } from './providers.js';

/** Read provider identities back after a response was lost. Never repeat provisioning POSTs. */
@Injectable()
export class FinanceReconciliation {
  constructor(
    private readonly prisma: PrismaService,
    private readonly safe: SafeHavenClient,
    private readonly sudo: SudoClient,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}
  async customer(userId: string) {
    const customer = await this.prisma.financeCustomer.findUnique({ where: { userId } });
    if (!customer) throw new NotFoundException('Financial customer not found');
    const update: Prisma.FinanceCustomerUpdateInput = {};
    const profile = await this.prisma.profile.findUniqueOrThrow({ where: { id: userId } });
    if (customer.sudoStatus === 'PROCESSING' && !customer.sudoId) {
      const matches: Record<string, unknown>[] = [];
      for (let page = 1; page <= 10; page++) {
        const data = await this.sudo.call(`/customers?page=${page}&limit=100`);
        if (!Array.isArray(data)) break;
        matches.push(
          ...data
            .map(object)
            .filter(
              (row) =>
                row.emailAddress === profile.email &&
                row.metadata &&
                object(row.metadata).bondeUserId === userId,
            ),
        );
        if (data.length < 100) break;
      }
      if (matches.length === 1) {
        update.sudoId = string(matches[0]._id);
        update.sudoStatus = 'READY';
      }
    }
    if (customer.bankStatus === 'PROCESSING' && !customer.bankAccountId) {
      const matches: Record<string, unknown>[] = [];
      for (let page = 0; page < 10; page++) {
        const data = await this.safe.call(`/accounts?isSubAccount=true&page=${page}&limit=100`);
        if (!Array.isArray(data)) break;
        matches.push(
          ...data.map(object).filter((row) => row.externalReference === `bonde:${userId}`),
        );
        if (data.length < 100) break;
      }
      if (matches.length === 1) {
        update.bankAccountId = string(matches[0]._id);
        update.bankAccountNumber = string(matches[0].accountNumber);
        update.bankAccountName = string(matches[0].accountName);
        update.bankCode = this.config.get('finance').safeHavenBankCode;
        update.bankStatus = 'READY';
      }
    }
    const ready =
      (customer.sudoId || update.sudoId) && (customer.bankAccountId || update.bankAccountId);
    await this.prisma.financeCustomer.update({
      where: { userId },
      data: { ...update, status: ready ? 'READY' : 'PENDING' },
    });
    return { reconciled: !!ready };
  }
  async liquidity() {
    const c = this.config.get('finance');
    const snapshots: Array<{ provider: string; currency: string; available: string | null }> = [];
    for (const currency of ['NGN', 'USD']) {
      const id = currency === 'NGN' ? c.ngnSettlementId : c.usdSettlementId;
      if (!id) continue;
      try {
        const data = object(await this.sudo.call(`/accounts/${encodeURIComponent(id)}/balance`));
        const amount = new Prisma.Decimal(String(data.availableBalance));
        if (!amount.isFinite()) throw new Error('Invalid provider balance');
        snapshots.push({ provider: 'sudo', currency, available: amount.toFixed(2) });
      } catch {
        snapshots.push({ provider: 'sudo', currency, available: null });
      }
    }
    try {
      const rows = await this.safe.call('/accounts?isSubAccount=false&page=0&limit=100');
      const account = Array.isArray(rows)
        ? rows.map(object).find((a) => a.accountNumber === c.treasuryAccountNumber)
        : undefined;
      snapshots.push({
        provider: 'safe-haven',
        currency: 'NGN',
        available: account ? new Prisma.Decimal(String(account.availableBalance)).toFixed(2) : null,
      });
    } catch {
      snapshots.push({ provider: 'safe-haven', currency: 'NGN', available: null });
    }
    // The linked Safe Haven and Sudo snapshots can represent the same assets. Never add them together.
    return { snapshots, overlapPossible: true };
  }
}
