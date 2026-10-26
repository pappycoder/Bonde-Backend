import { FinanceRetirement } from './finance-retirement.service.js';
import { FinancePolicy } from './finance-policy.service.js';
import { projectAllocationReturn } from './finance-projections.js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type FinanceOperation } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LedgerService, type Posting } from './ledger.service.js';
import { SafeHavenClient, SudoClient, object, string, ProviderError } from './providers.js';
import { FinanceCapabilities } from './finance-capabilities.service.js';
import { cardKey, holdKey, systemKey, walletKey } from './finance.types.js';
import type { FinanceCommandDto } from './finance.dto.js';

@Injectable()
export class FinanceWorker {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly sudo: SudoClient,
    private readonly safe: SafeHavenClient,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly capabilities: FinanceCapabilities,
    private readonly retirement: FinanceRetirement,
    private readonly policy: FinancePolicy,
  ) {}
  async run() {
    this.capabilities.assertEnabled();
    await this.retirement.scan();
    await this.prisma.financeOperation.updateMany({
      where: { status: 'PROCESSING', leaseUntil: { lt: new Date() } },
      data: { status: 'UNKNOWN' },
    });
    const pending = await this.prisma.financeOperation.findMany({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
    for (const op of pending) await this.process(op.id);
    const uncertain = await this.prisma.financeOperation.findMany({
      where: { status: { in: ['UNKNOWN', 'PENDING'] } },
      take: 20,
      orderBy: { updatedAt: 'asc' },
    });
    for (const op of uncertain) await this.reconcile(op).catch(() => undefined);
    return { processed: pending.length, reconciled: uncertain.length };
  }
  async process(id: string) {
    const claim = await this.prisma.financeOperation.updateMany({
      where: { id, status: 'QUEUED' },
      data: {
        status: 'PROCESSING',
        attempts: { increment: 1 },
        leaseUntil: new Date(Date.now() + 60000),
      },
    });
    if (!claim.count) return;
    const op = await this.prisma.financeOperation.findUniqueOrThrow({ where: { id } });
    try {
      if (op.kind === 'RETIRE') await this.retirement.process(op);
      else if (op.kind === 'ISSUE') await this.issue(op);
      else if (op.kind === 'SWEEP') await this.sweep(op);
      else if (op.kind === 'WITHDRAW') await this.withdraw(op);
      else if (['PAUSE', 'RESUME', 'CANCEL'].includes(op.kind)) await this.lifecycle(op);
    } catch (error) {
      if (error instanceof ProviderError && error.definitive) await this.fail(op);
      else
        await this.prisma.financeOperation.updateMany({
          where: { id, status: 'PROCESSING' },
          data: { status: 'UNKNOWN', leaseUntil: null },
        });
    }
  }
  private posting(
    op: FinanceOperation,
    key: string,
    amount: Prisma.Decimal,
    kind: string,
    user = true,
  ): Posting {
    return { key, currency: op.currency, amount, kind, ...(user ? { userId: op.userId } : {}) };
  }
  async fail(op: FinanceOperation) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM profiles WHERE id=${op.userId}::uuid FOR UPDATE`;
      const current = await tx.financeOperation.findUniqueOrThrow({ where: { id: op.id } });
      if (['FAILED', 'SUCCEEDED', 'REVERSED'].includes(current.status)) return;
      if (['ISSUE', 'WITHDRAW'].includes(op.kind))
        await this.ledger.post(tx, `release:${op.id}`, 'Failed operation funds returned', [
          this.posting(op, holdKey(op.id, op.currency), op.amount.add(op.fee).negated(), 'HOLD'),
          this.posting(op, walletKey(op.userId, op.currency), op.amount.add(op.fee), 'WALLET'),
        ]);
      if (op.kind === 'ISSUE' && op.cardId)
        await tx.card.update({ where: { id: op.cardId }, data: { status: 'CANCELLED' } });
      await tx.financeOperation.update({
        where: { id: op.id },
        data: { status: 'FAILED', leaseUntil: null },
      });
      await tx.transaction.updateMany({ where: { id: op.id }, data: { status: 'FAIL' } });
    });
  }
  private async issue(op: FinanceOperation) {
    const c = this.config.get('finance');
    const customer = await this.prisma.financeCustomer.findUniqueOrThrow({
      where: { userId: op.userId },
    });
    const sourceId = op.currency === 'NGN' ? c.ngnFundingSourceId : c.usdFundingSourceId;
    let source: Record<string, unknown>;
    try {
      source = object(await this.sudo.call(`/fundingsources/${encodeURIComponent(sourceId)}`));
    } catch {
      throw new ProviderError(true, 400);
    }
    const gateway = object(source.jitGateway);
    if (
      source.type !== 'gateway' ||
      source.status !== 'active' ||
      gateway.authorizeByDefault !== false ||
      gateway.url !== `${this.config.get('publicUrl').replace(/\/$/, '')}/api/finance/webhooks/sudo`
    )
      throw new ProviderError(true, 400);
    const data = object(
      await this.sudo.call('/cards', 'POST', {
        customerId: customer.sudoId,
        type: 'virtual',
        currency: op.currency,
        issuerCountry: op.currency === 'NGN' ? 'NGA' : 'USA',
        brand: op.currency === 'NGN' ? c.ngnBrand : c.usdBrand,
        status: 'active',
        enable2FA: true,
        fundingSourceId: op.currency === 'NGN' ? c.ngnFundingSourceId : c.usdFundingSourceId,
        debitAccountId: op.currency === 'NGN' ? c.ngnSettlementId : c.usdSettlementId,
        metadata: { bondeOperationId: op.id },
        spendingControls: { channels: { atm: false, pos: false, web: true, mobile: true } },
      }),
    );
    // Persist the provider identifier before finalizing balances: reconciliation can safely finish later.
    await this.prisma.financeOperation.update({
      where: { id: op.id },
      data: { providerReference: string(data._id) },
    });
    await this.prisma.card.update({
      where: { id: op.cardId! },
      data: { externalReferenceId: string(data._id) },
    });
    await this.finishIssue(op, data);
  }
  private async finishIssue(op: FinanceOperation, data: Record<string, unknown>) {
    if (data.status === 'canceled') throw new ProviderError(false, 409);
    const id = string(data._id),
      last4 = string(data.maskedPan).slice(-4);
    const year = Number(data.expiryYear),
      month = Number(data.expiryMonth);
    if (
      !/^\d{4}$/.test(last4) ||
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12
    )
      throw new ProviderError(false, 502);
    const expiry = new Date(Date.UTC(year < 100 ? year + 2000 : year, month, 1));
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM profiles WHERE id=${op.userId}::uuid FOR UPDATE`;
      const current = await tx.financeOperation.findUniqueOrThrow({ where: { id: op.id } });
      if (current.status === 'SUCCEEDED' || current.status === 'FAILED') return;
      if (!(await tx.financeJournal.findUnique({ where: { reference: `issue:${op.id}` } }))) {
        const lines = [
          this.posting(op, holdKey(op.id, op.currency), op.amount.add(op.fee).negated(), 'HOLD'),
          this.posting(op, cardKey(op.cardId!, op.currency), op.amount, 'CARD'),
        ];
        if (op.fee.gt(0))
          lines.push(this.posting(op, systemKey('fees', op.currency), op.fee, 'FEES', false));
        await this.ledger.post(tx, `issue:${op.id}`, 'Card allocation and issuance fee', lines);
      }
      const card = await tx.card.findUniqueOrThrow({ where: { id: op.cardId! } });
      await tx.card.update({
        where: { id: op.cardId! },
        data: {
          externalReferenceId: id,
          cardNumberLast4: last4,
          expirationDate: expiry,
          balance: (
            await tx.financeAccount.findUniqueOrThrow({
              where: { key: cardKey(op.cardId!, op.currency) },
            })
          ).balance,
          status: data.status === 'active' && !card.retiredAt ? 'ACTIVE' : 'PAUSED',
        },
      });
      await tx.transaction.updateMany({
        where: { id: op.id },
        data: { status: data.status === 'active' ? 'SUCCESS' : 'PENDING' },
      });
      await tx.financeOperation.update({
        where: { id: op.id },
        data: {
          providerReference: id,
          status: data.status === 'active' ? 'SUCCEEDED' : 'PENDING',
          leaseUntil: null,
        },
      });
    });
  }
  private async withdraw(op: FinanceOperation) {
    const command = op.request as unknown as FinanceCommandDto;
    let resolved: Record<string, unknown>;
    try {
      resolved = object(await this.safe.resolve(command.bankCode!, command.accountNumber!));
    } catch {
      throw new ProviderError(true, 400);
    }
    if (resolved.accountName !== command.accountName) throw new ProviderError(true, 400);
    const transfer = object(
      await this.safe.call('/transfers', 'POST', {
        nameEnquiryReference: string(resolved.sessionId),
        debitAccountNumber: this.config.get('finance').treasuryAccountNumber,
        beneficiaryBankCode: command.bankCode,
        beneficiaryAccountNumber: command.accountNumber,
        amount: Number(op.amount),
        paymentReference: op.id,
        narration: 'Bonde wallet withdrawal',
        saveBeneficiary: false,
      }),
    );
    await this.prisma.financeOperation.update({
      where: { id: op.id },
      data: { providerReference: string(transfer.sessionId), status: 'PENDING', leaseUntil: null },
    });
    await this.settleWithdrawal(op, transfer);
  }
  async settleWithdrawal(op: FinanceOperation, data: Record<string, unknown>) {
    const command = op.request as unknown as FinanceCommandDto;
    if (
      data.debitAccountNumber !== this.config.get('finance').treasuryAccountNumber ||
      data.creditAccountNumber !== command.accountNumber ||
      data.destinationInstitutionCode !== command.bankCode
    )
      throw new ProviderError(false, 400);
    if (data.paymentReference !== op.id || String(data.amount) !== op.amount.toString())
      throw new ProviderError(false, 502);
    if (data.status === 'Failed' || data.status === 'Canceled') {
      await this.fail(op);
      return;
    }
    if (data.status !== 'Completed') return;
    const actualFee = new Prisma.Decimal(String(data.fees ?? 0))
      .add(String(data.vat ?? 0))
      .add(String(data.stampDuty ?? 0));
    if (!actualFee.isFinite() || actualFee.lt(0)) throw new ProviderError(false, 502);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM profiles WHERE id=${op.userId}::uuid FOR UPDATE`;
      const current = await tx.financeOperation.findUniqueOrThrow({ where: { id: op.id } });
      if (current.status === 'SUCCEEDED') return;
      if (current.status === 'FAILED' || current.status === 'REVERSED')
        throw new ProviderError(false, 409);
      await this.ledger.post(tx, `payout:${op.id}`, 'Bank payout settled', [
        this.posting(op, holdKey(op.id, op.currency), op.amount.add(op.fee).negated(), 'HOLD'),
        this.posting(
          op,
          systemKey('bank-clearing', op.currency),
          op.amount.add(actualFee),
          'CLEARING',
          false,
        ),
        ...(actualFee.lt(op.fee)
          ? [this.posting(op, walletKey(op.userId, op.currency), op.fee.sub(actualFee), 'WALLET')]
          : []),
        ...(actualFee.gt(op.fee)
          ? [
              this.posting(
                op,
                systemKey('fee-variance', op.currency),
                op.fee.sub(actualFee),
                'EXPENSE',
                false,
              ),
            ]
          : []),
      ]);
      if (actualFee.gt(op.fee))
        await tx.financeInbox.upsert({
          where: {
            provider_reference: { provider: 'safe-haven', reference: `fee-variance:${op.id}` },
          },
          create: {
            id: randomUUID(),
            provider: 'safe-haven',
            reference: `fee-variance:${op.id}`,
            eventType: 'fee.variance',
            status: 'REVIEW',
            errorCode: 'FEE_EXCEEDED_QUOTE',
            payload: {
              operationId: op.id,
              quotedFee: op.fee.toFixed(2),
              actualFee: actualFee.toFixed(2),
            },
          },
          update: {},
        });
      await tx.financeOperation.update({
        where: { id: op.id },
        data: {
          status: 'SUCCEEDED',
          leaseUntil: null,
          result: {
            providerFee: actualFee.toFixed(2),
            customerFee: Prisma.Decimal.min(actualFee, op.fee).toFixed(2),
          },
        },
      });
      await tx.transaction.updateMany({ where: { id: op.id }, data: { status: 'SUCCESS' } });
      const chargedFee = Prisma.Decimal.min(actualFee, op.fee).toFixed(2);
      await tx.$executeRaw`UPDATE transactions SET metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{fee}',to_jsonb(${chargedFee}::text)) WHERE id=${op.id}::uuid`;
    });
  }
  private async lifecycle(op: FinanceOperation) {
    await this.retirement.lease(op.cardId!, op.id);
    try {
      await this.lifecycleLeased(op);
    } finally {
      await this.retirement.release(op.cardId!, op.id);
    }
  }
  private async lifecycleLeased(op: FinanceOperation) {
    const card = await this.prisma.card.findUniqueOrThrow({ where: { id: op.cardId! } });
    if (!card.externalReferenceId) throw new ProviderError(true, 400);
    if (op.kind === 'RESUME') {
      const snapshot = await this.policy.snapshot(this.prisma, card);
      if (card.retiredAt || snapshot.reason || card.status === 'CANCELLED') {
        if (snapshot.reason) await this.retirement.ensureDue(card.userId, card.id);
        await this.prisma.financeOperation.update({
          where: { id: op.id },
          data: { status: 'SUPERSEDED', leaseUntil: null },
        });
        return;
      }
    }
    // Cancellation must use a documented supported terminal state. Provider rejection leaves the allocation intact.
    await this.sudo.call(`/cards/${encodeURIComponent(card.externalReferenceId)}`, 'PUT', {
      status: op.kind === 'RESUME' ? 'active' : op.kind === 'PAUSE' ? 'inactive' : 'canceled',
      ...(op.kind === 'CANCEL'
        ? {
            cancellationReason: (op.request as unknown as FinanceCommandDto).cancellationReason,
            creditAccountId:
              op.currency === 'NGN'
                ? this.config.get('finance').ngnSettlementId
                : this.config.get('finance').usdSettlementId,
          }
        : {}),
    });
    await this.finishLifecycle(op);
  }
  private async finishLifecycle(op: FinanceOperation) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM profiles WHERE id=${op.userId}::uuid FOR UPDATE`;
      const current = await tx.financeOperation.findUniqueOrThrow({ where: { id: op.id } });
      if (current.status === 'SUCCEEDED') return;
      const local = await tx.card.findUniqueOrThrow({ where: { id: op.cardId! } });
      if (
        op.kind === 'RESUME' &&
        (local.retiredAt ||
          (await this.policy.snapshot(tx, local)).reason ||
          local.status === 'CANCELLED')
      ) {
        await tx.financeOperation.update({
          where: { id: op.id },
          data: { status: 'SUPERSEDED', leaseUntil: null },
        });
        return;
      }
      if (op.kind === 'CANCEL') {
        const held = await tx.financeAuthorization.count({
          where: { cardId: op.cardId!, status: 'HELD' },
        });
        if (held) throw new ProviderError(false, 409);
        const account = await tx.financeAccount.findUnique({
          where: { key: cardKey(op.cardId!, op.currency) },
        });
        if (account?.balance.gt(0)) {
          await this.ledger.post(tx, `close:${op.id}`, 'Closed card allocation returned', [
            this.posting(op, account.key, account.balance.negated(), 'CARD'),
            this.posting(op, walletKey(op.userId, op.currency), account.balance, 'WALLET'),
          ]);
          await projectAllocationReturn(tx, {
            userId: op.userId,
            cardId: op.cardId!,
            currency: op.currency,
            amount: account.balance,
            reference: `close:${op.id}`,
            operationId: op.id,
          });
        }
      }
      await tx.card.update({
        where: { id: op.cardId! },
        data: {
          status: op.kind === 'RESUME' ? 'ACTIVE' : op.kind === 'PAUSE' ? 'PAUSED' : 'CANCELLED',
          ...(op.kind === 'CANCEL' ? { balance: 0, retirementStatus: 'CLOSED' } : {}),
        },
      });
      await tx.cardHistory.create({
        data: {
          id: randomUUID(),
          cardId: op.cardId!,
          event: op.kind.toLowerCase(),
          changes: { operationId: op.id },
        },
      });
      await tx.financeOperation.update({
        where: { id: op.id },
        data: { status: 'SUCCEEDED', leaseUntil: null },
      });
      await tx.transaction.updateMany({ where: { id: op.id }, data: { status: 'SUCCESS' } });
    });
  }
  private async sweep(op: FinanceOperation) {
    const c = this.config.get('finance');
    const source = string((op.request as Record<string, unknown>).sourceAccountNumber);
    const enquiry = object(await this.safe.resolve(c.safeHavenBankCode, c.treasuryAccountNumber));
    const data = object(
      await this.safe.call('/transfers', 'POST', {
        nameEnquiryReference: string(enquiry.sessionId),
        debitAccountNumber: source,
        beneficiaryBankCode: c.safeHavenBankCode,
        beneficiaryAccountNumber: c.treasuryAccountNumber,
        amount: Number(op.amount),
        paymentReference: op.id,
        narration: 'Bonde treasury sweep',
        saveBeneficiary: false,
      }),
    );
    await this.prisma.financeOperation.update({
      where: { id: op.id },
      data: { providerReference: string(data.sessionId), status: 'PENDING', leaseUntil: null },
    });
    await this.settleSweep(op, data);
  }
  async settleSweep(op: FinanceOperation, data: Record<string, unknown>) {
    if (data.paymentReference !== op.id || String(data.amount) !== op.amount.toString())
      throw new ProviderError(false, 400);
    const status =
      data.isReversed === true
        ? 'REVERSED'
        : data.status === 'Completed'
          ? 'SUCCEEDED'
          : data.status === 'Failed' || data.status === 'Canceled'
            ? 'FAILED'
            : 'PENDING';
    await this.prisma.financeOperation.update({
      where: { id: op.id },
      data: { status, leaseUntil: null },
    });
    // A sweep moves existing assets. It never produces a second customer credit.
  }
  private async discover(op: FinanceOperation) {
    if (op.kind === 'ISSUE') {
      const customer = await this.prisma.financeCustomer.findUniqueOrThrow({
        where: { userId: op.userId },
      });
      for (let page = 1; page <= 10; page++) {
        const data = await this.sudo.call(
          `/cards?customerId=${encodeURIComponent(customer.sudoId!)}&page=${page}&limit=100`,
        );
        if (!Array.isArray(data)) return;
        const matches = data
          .map(object)
          .filter((card) => card.metadata && object(card.metadata).bondeOperationId === op.id);
        if (matches.length === 1) {
          const id = string(matches[0]._id);
          await this.prisma.financeOperation.update({
            where: { id: op.id },
            data: { providerReference: id },
          });
          return { ...op, providerReference: id };
        }
        if (matches.length > 1 || data.length < 100) return;
      }
    }
    if (op.kind === 'WITHDRAW' || op.kind === 'SWEEP') {
      const accounts = await this.safe.call('/accounts?isSubAccount=false&page=0&limit=100');
      if (!Array.isArray(accounts)) return;
      const number =
        op.kind === 'SWEEP'
          ? string((op.request as Record<string, unknown>).sourceAccountNumber)
          : this.config.get('finance').treasuryAccountNumber;
      let account = accounts.map(object).find((a) => a.accountNumber === number);
      if (!account && op.kind === 'SWEEP') {
        const customer = await this.prisma.financeCustomer.findUnique({
          where: { userId: op.userId },
        });
        if (customer?.bankAccountId) account = { _id: customer.bankAccountId };
      }
      if (!account) return;
      for (let page = 0; page < 10; page++) {
        const data = await this.safe.call(
          `/transfers?accountId=${encodeURIComponent(string(account._id))}&page=${page}&limit=100&fromDate=${encodeURIComponent(op.createdAt.toISOString())}`,
        );
        if (!Array.isArray(data)) return;
        const matches = data.map(object).filter((transfer) => transfer.paymentReference === op.id);
        if (matches.length === 1) {
          const id = string(matches[0].sessionId);
          await this.prisma.financeOperation.update({
            where: { id: op.id },
            data: { providerReference: id },
          });
          return { ...op, providerReference: id };
        }
        if (matches.length > 1 || data.length < 100) return;
      }
    }
  }
  private async reconcile(original: FinanceOperation) {
    if (original.kind === 'RETIRE') {
      const claim = await this.prisma.financeOperation.updateMany({
        where: { id: original.id, status: { in: ['UNKNOWN', 'PENDING'] } },
        data: { status: 'PROCESSING', leaseUntil: new Date(Date.now() + 60000) },
      });
      if (claim.count)
        await this.retirement.process(original).catch(async () => {
          await this.prisma.financeOperation.update({
            where: { id: original.id },
            data: { status: 'UNKNOWN', leaseUntil: null },
          });
        });
      return;
    }
    const op = !original.providerReference
      ? ((await this.discover(original)) ?? original)
      : original;
    if (op.kind === 'ISSUE' && op.providerReference)
      await this.finishIssue(
        op,
        object(await this.sudo.call(`/cards/${encodeURIComponent(op.providerReference)}`)),
      );
    if (op.kind === 'SWEEP' && op.providerReference)
      await this.settleSweep(
        op,
        object(await this.safe.call('/transfers/tqs', 'POST', { sessionId: op.providerReference })),
      );
    if (op.kind === 'WITHDRAW' && op.providerReference)
      await this.settleWithdrawal(
        op,
        object(await this.safe.call('/transfers/tqs', 'POST', { sessionId: op.providerReference })),
      );
    if (['PAUSE', 'RESUME', 'CANCEL'].includes(op.kind) && op.cardId) {
      const card = await this.prisma.card.findUniqueOrThrow({ where: { id: op.cardId } });
      if (!card.externalReferenceId) return;
      const result = object(
        await this.sudo.call(`/cards/${encodeURIComponent(card.externalReferenceId)}`),
      );
      const expected =
        op.kind === 'RESUME' ? 'active' : op.kind === 'PAUSE' ? 'inactive' : 'canceled';
      if (result.status === expected) await this.finishLifecycle(op);
    }
    // Missing provider IDs remain UNKNOWN for investigation. Never repeat a money-moving POST.
  }
}
