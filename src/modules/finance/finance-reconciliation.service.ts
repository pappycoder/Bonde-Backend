import { cardProgrammes } from './card-programmes.js';
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
    const snapshots: Array<{
      provider: string;
      currency: string;
      accountId: string;
      brands: string[];
      available: string | null;
    }> = [];
    const accounts = new Map<string, { currency: string; id: string; brands: Set<string> }>();
    const add = (currency: string, id: string | undefined, brand?: string) => {
      if (!id) return;
      const key = `${currency}:${id}`;
      const entry = accounts.get(key) ?? { currency, id, brands: new Set<string>() };
      if (brand) entry.brands.add(brand);
      accounts.set(key, entry);
    };
    for (const currency of ['NGN', 'USD']) {
      for (const p of cardProgrammes(c, currency)) add(currency, p.settlementId, p.brand);
      add(currency, currency === 'NGN' ? c.ngnSettlementId : c.usdSettlementId);
    }
    // Removed programmes may still have issued cards or unsettled purchases.
    const historical = await this.prisma.$queryRaw<
      Array<{ currency: string; id: string; brand: string | null }>
    >`
      SELECT DISTINCT currency, request->'issuanceProgramme'->>'settlementId' AS id,
        request->'issuanceProgramme'->>'brand' AS brand
      FROM finance_operations WHERE kind='ISSUE'
        AND request->'issuanceProgramme'->>'settlementId' IS NOT NULL`;
    for (const row of historical) add(row.currency, row.id, row.brand ?? undefined);
    for (const { currency, id, brands } of accounts.values()) {
      let available: string | null = null;
      try {
        const data = object(await this.sudo.call(`/accounts/${encodeURIComponent(id)}/balance`));
        const amount = new Prisma.Decimal(String(data.availableBalance));
        if (!amount.isFinite()) throw new Error('Invalid provider balance');
        available = amount.toFixed(2);
      } catch {
        /* Surface an unavailable account rather than hiding it. */
      }
      snapshots.push({ provider: 'sudo', currency, accountId: id, brands: [...brands], available });
    }
    let treasury: string | null = null;
    try {
      for (let page = 0; page < 10; page++) {
        const rows = await this.safe.call(`/accounts?isSubAccount=false&page=${page}&limit=100`);
        if (!Array.isArray(rows)) break;
        const account = rows.map(object).find((a) => a.accountNumber === c.treasuryAccountNumber);
        if (account) {
          const amount = new Prisma.Decimal(String(account.availableBalance));
          if (amount.isFinite()) treasury = amount.toFixed(2);
          break;
        }
        if (rows.length < 100) break;
      }
    } catch {
      /* Missing treasury evidence is visible to the operator. */
    }
    snapshots.push({
      provider: 'safe-haven',
      currency: 'NGN',
      accountId: c.treasuryAccountNumber,
      brands: [],
      available: treasury,
    });
    // The linked Safe Haven and Sudo snapshots can represent the same assets. Never add them together.
    return { snapshots, overlapPossible: true };
  }
}
