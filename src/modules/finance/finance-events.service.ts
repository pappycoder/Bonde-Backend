import { projectAllocationReturn } from './finance-projections.js';
import type { Card } from '@prisma/client';
import { budgetAlertTitles } from './card-policy.js';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LedgerService } from './ledger.service.js';
import { FinanceWorker } from './finance-worker.service.js';
import { SafeHavenClient, SudoClient, object, string, ProviderError } from './providers.js';
import { amountOf, cardKey, holdKey, systemKey, walletKey } from './finance.types.js';

@Injectable()
export class FinanceEvents {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly safe: SafeHavenClient,
    private readonly sudo: SudoClient,
    private readonly worker: FinanceWorker,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}
  async receive(
    provider: string,
    eventType: string,
    id: string,
    extra: Record<string, string> = {},
  ) {
    // Persist references only: provider payloads may contain identities, OTPs or sensitive card data.
    await this.prisma.financeInbox.upsert({
      where: {
        provider_reference: {
          provider,
          reference: `${eventType}:${id}:${extra.deliveryId ?? extra.status ?? ''}:${extra.reversed ?? ''}`,
        },
      },
      create: {
        id: randomUUID(),
        provider,
        reference: `${eventType}:${id}:${extra.deliveryId ?? extra.status ?? ''}:${extra.reversed ?? ''}`,
        eventType,
        payload: { id, ...extra },
      },
      update: {},
    });
    return { received: true };
  }
  async run() {
    const events = await this.prisma.financeInbox.findMany({
      where: { status: { in: ['RECEIVED', 'RETRY'] } },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });
    for (const event of events) {
      try {
        const ref = event.payload as Record<string, string>;
        if (event.provider === 'safe-haven')
          await this.bankEvent(event.id, event.eventType, ref.id, ref.sessionId);
        else await this.sudoEvent(event.id, event.eventType, ref.id);
      } catch (error) {
        await this.prisma.financeInbox.update({
          where: { id: event.id },
          data: {
            status: error instanceof ProviderError && error.definitive ? 'REVIEW' : 'RETRY',
            errorCode: 'PROVIDER_OR_RECONCILIATION_REQUIRED',
          },
        });
      }
    }
    return { events: events.length };
  }
  private async bankEvent(inboxId: string, type: string, id: string, sessionId?: string) {
    if (!sessionId) throw new ProviderError(true, 400);
    const data = object(await this.safe.call('/transfers/tqs', 'POST', { sessionId }));
    if (data._id !== id || data.sessionId !== sessionId) throw new ProviderError(true, 400);
    if (type === 'account.credit') {
      if (data.status !== 'Completed' || data.type !== 'Inwards' || data.isReversed === true)
        throw new ProviderError(true, 400);
      const customer = await this.prisma.financeCustomer.findFirst({
        where: { bankAccountNumber: string(data.creditAccountNumber), bankStatus: 'READY' },
      });
      if (!customer) throw new ProviderError(true, 404);
      if (data.account !== customer.bankAccountId) throw new ProviderError(true, 400);
      const gross = amountOf(String(data.amount));
      const fees = new Prisma.Decimal(String(data.fees ?? 0))
        .add(String(data.vat ?? 0))
        .add(String(data.stampDuty ?? 0));
      if (!fees.isFinite() || fees.lt(0)) throw new ProviderError(true, 400);
      const bearer = this.config.get('finance').incomingFeeBearer;
      if (bearer === 'unknown') throw new ProviderError(true, 409);
      const amount = amountOf((bearer === 'recipient' ? gross.sub(fees) : gross).toFixed(2));
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM profiles WHERE id=${customer.userId}::uuid FOR UPDATE`;
        const reference = `deposit:${id}`;
        if (!(await tx.financeJournal.findUnique({ where: { reference } }))) {
          await this.ledger.post(tx, reference, 'Verified bank deposit', [
            {
              key: systemKey('bank-clearing', 'NGN'),
              kind: 'CLEARING',
              currency: 'NGN',
              amount: amount.negated(),
            },
            {
              key: walletKey(customer.userId, 'NGN'),
              userId: customer.userId,
              kind: 'WALLET',
              currency: 'NGN',
              amount,
            },
          ]);
          await this.project(tx, customer.userId, 'DEPOSIT', amount, 'NGN', `deposit:${id}`, null, {
            gross: gross.toFixed(2),
            fee: bearer === 'recipient' ? fees.toFixed(2) : '0.00',
          });
          await tx.financeOperation.create({
            data: {
              id: randomUUID(),
              userId: customer.userId,
              idempotencyKey: `sweep:${id}`,
              fingerprint: `sweep:${id}`,
              kind: 'SWEEP',
              currency: 'NGN',
              amount,
              request: { sourceAccountNumber: customer.bankAccountNumber },
            },
          });
        }
        await tx.financeInbox.update({ where: { id: inboxId }, data: { status: 'PROCESSED' } });
      });
    } else if (type === 'account.debit') {
      const op = await this.prisma.financeOperation.findFirst({
        where: { id: string(data.paymentReference), kind: { in: ['WITHDRAW', 'SWEEP'] } },
      });
      if (!op) throw new ProviderError(true, 404);
      if (op.kind === 'SWEEP') {
        await this.worker.settleSweep(op, data);
        await this.prisma.financeInbox.update({
          where: { id: inboxId },
          data: { status: 'PROCESSED' },
        });
        return;
      }
      if (data.isReversed === true) {
        const command = op.request as Record<string, unknown>;
        if (
          !command.accountNumber ||
          data.creditAccountNumber !== command.accountNumber ||
          data.destinationInstitutionCode !== command.bankCode ||
          String(data.amount) !== op.amount.toString()
        )
          throw new ProviderError(false, 400);
        await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM profiles WHERE id=${op.userId}::uuid FOR UPDATE`;
          const current = await tx.financeOperation.findUniqueOrThrow({ where: { id: op.id } });
          if (current.status === 'SUCCEEDED') {
            // Return only confirmed reversed principal; fees require their own provider confirmation.
            await this.ledger.post(tx, `payout-reversal:${id}`, 'Bank payout reversed', [
              {
                key: systemKey('bank-clearing', op.currency),
                kind: 'CLEARING',
                currency: op.currency,
                amount: op.amount.negated(),
              },
              {
                key: walletKey(op.userId, op.currency),
                userId: op.userId,
                kind: 'WALLET',
                currency: op.currency,
                amount: op.amount,
              },
            ]);
            await tx.financeOperation.update({
              where: { id: op.id },
              data: { status: 'REVERSED' },
            });
          } else if (current.status !== 'REVERSED') throw new ProviderError(false, 409);
          await tx.financeInbox.update({ where: { id: inboxId }, data: { status: 'PROCESSED' } });
        });
      } else {
        await this.worker.settleWithdrawal(op, data);
        if (data.status !== 'Completed' && data.status !== 'Failed' && data.status !== 'Canceled')
          throw new ProviderError(false, 202);
        await this.prisma.financeInbox.update({
          where: { id: inboxId },
          data: { status: 'PROCESSED' },
        });
      }
    } else throw new ProviderError(true, 400);
  }
  private async sudoEvent(inboxId: string, type: string, id: string) {
    if (type === 'authorization.declined') {
      const data = object(await this.sudo.call(`/authorizations/${encodeURIComponent(id)}`));
      if (data._id !== id || data.status !== 'declined') throw new ProviderError(false, 409);
      const auth = await this.prisma.financeAuthorization.findUnique({ where: { id } });
      if (!auth) {
        await this.prisma.financeInbox.update({
          where: { id: inboxId },
          data: { status: 'PROCESSED' },
        });
        return;
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM profiles WHERE id=${auth.userId}::uuid FOR UPDATE`;
        const current = await tx.financeAuthorization.findUniqueOrThrow({ where: { id } });
        if (current.status === 'HELD' && current.settled.isZero()) {
          const held = current.amount.sub(current.released);
          if (held.gt(0))
            await this.ledger.post(tx, `declined:${id}`, 'Declined purchase hold returned', [
              {
                key: holdKey(id, current.currency),
                kind: 'HOLD',
                currency: current.currency,
                userId: current.userId,
                amount: held.negated(),
              },
              {
                key: cardKey(current.cardId, current.currency),
                kind: 'CARD',
                currency: current.currency,
                userId: current.userId,
                amount: held,
              },
            ]);
          await tx.card.update({
            where: { id: current.cardId },
            data: { balance: { increment: held } },
          });
          await tx.financeAuthorization.update({
            where: { id },
            data: { released: current.amount, status: 'DECLINED' },
          });
        }
        await tx.financeInbox.update({ where: { id: inboxId }, data: { status: 'PROCESSED' } });
      });
      return;
    }
    if (type === 'card.updated' || type === 'card.terminated') {
      const data = object(await this.sudo.call(`/cards/${encodeURIComponent(id)}`));
      if (data._id !== id) throw new ProviderError(true, 400);
      const card = await this.prisma.card.findFirst({
        where: { externalReferenceId: id, issuer: 'sudo' },
      });
      if (!card) throw new ProviderError(true, 404);
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM profiles WHERE id=${card.userId}::uuid FOR UPDATE`;
        const held = await tx.financeAuthorization.count({
          where: { cardId: card.id, status: 'HELD' },
        });
        if (data.status === 'canceled' && held) {
          await tx.card.update({ where: { id: card.id }, data: { status: 'PAUSED' } });
          await tx.financeInbox.update({
            where: { id: inboxId },
            data: { status: 'RETRY', errorCode: 'OUTSTANDING_HOLDS' },
          });
          return;
        }
        if (data.status === 'canceled') {
          const account = await tx.financeAccount.findUnique({
            where: { key: cardKey(card.id, card.currency) },
          });
          if (account?.balance.gt(0)) {
            await this.ledger.post(
              tx,
              `issuer-close:${card.id}`,
              'Issuer closed card allocation returned',
              [
                {
                  key: account.key,
                  currency: card.currency,
                  userId: card.userId,
                  kind: 'CARD',
                  amount: account.balance.negated(),
                },
                {
                  key: walletKey(card.userId, card.currency),
                  currency: card.currency,
                  userId: card.userId,
                  kind: 'WALLET',
                  amount: account.balance,
                },
              ],
            );
            await projectAllocationReturn(tx, {
              userId: card.userId,
              cardId: card.id,
              currency: card.currency,
              amount: account.balance,
              reference: `issuer-close:${card.id}`,
            });
          }
        }
        if (!['active', 'inactive', 'canceled'].includes(String(data.status)))
          throw new ProviderError(false, 409);
        await tx.card.update({
          where: { id: card.id },
          data: {
            status:
              data.status === 'active'
                ? 'ACTIVE'
                : data.status === 'inactive'
                  ? 'PAUSED'
                  : 'CANCELLED',
            ...(data.status === 'canceled' ? { balance: 0 } : {}),
          },
        });
        await tx.financeInbox.update({ where: { id: inboxId }, data: { status: 'PROCESSED' } });
      });
      return;
    }
    if (!['transaction.created', 'transaction.refund'].includes(type))
      throw new ProviderError(true, 400);
    const data = object(await this.sudo.call(`/transactions/${encodeURIComponent(id)}`));
    if (data._id !== id) throw new ProviderError(true, 400);
    const cardId = typeof data.card === 'string' ? data.card : string(object(data.card)._id);
    const card = await this.prisma.card.findFirst({
      where: { externalReferenceId: cardId, issuer: 'sudo' },
    });
    if (!card || data.currency !== card.currency) throw new ProviderError(true, 400);
    const authId =
      typeof data.authorization === 'string'
        ? data.authorization
        : data.authorization
          ? string(object(data.authorization)._id)
          : null;
    if (!authId) throw new ProviderError(true, 409); // Unmatched fees/captures need explicit reconciliation, never a guessed user debit.
    const amount = amountOf(
      new Prisma.Decimal(String(data.amount))
        .abs()
        .add(String(data.fee ?? 0))
        .add(String(data.vat ?? 0))
        .toFixed(2),
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM profiles WHERE id=${card.userId}::uuid FOR UPDATE`;
      const inbox = await tx.financeInbox.findUniqueOrThrow({ where: { id: inboxId } });
      if (inbox.status === 'PROCESSED') return;
      const auth = await tx.financeAuthorization.findUnique({ where: { id: authId } });
      if (!auth || auth.cardId !== card.id) throw new ProviderError(false, 409);
      const refund = type === 'transaction.refund';
      if (
        await tx.financeJournal.findFirst({
          where: { reference: { in: [`sudo:${type}:${id}`, `sudo:reversal:${id}`] } },
        })
      ) {
        await tx.financeInbox.update({ where: { id: inboxId }, data: { status: 'PROCESSED' } });
        return;
      }
      if (refund && auth.settled.isZero() && auth.status === 'HELD') {
        if (auth.released.add(amount).gt(auth.amount)) throw new ProviderError(false, 409);
        const reference = `sudo:reversal:${id}`;
        if (!(await tx.financeJournal.findUnique({ where: { reference } }))) {
          await this.ledger.post(tx, reference, 'Authorization reversal', [
            {
              key: holdKey(auth.id, card.currency),
              userId: card.userId,
              kind: 'HOLD',
              currency: card.currency,
              amount: amount.negated(),
            },
            {
              key: cardKey(card.id, card.currency),
              userId: card.userId,
              kind: 'CARD',
              currency: card.currency,
              amount,
            },
          ]);
          await tx.financeAuthorization.update({
            where: { id: auth.id },
            data: {
              released: { increment: amount },
              status: auth.released.add(amount).equals(auth.amount) ? 'REVERSED' : 'HELD',
            },
          });
          await tx.card.update({
            where: { id: card.id },
            data: { balance: { increment: amount } },
          });
        }
        await tx.financeInbox.update({ where: { id: inboxId }, data: { status: 'PROCESSED' } });
        return;
      }
      const source = refund
        ? systemKey('card-clearing', card.currency)
        : holdKey(auth.id, card.currency);
      const destination = refund
        ? card.status === 'CANCELLED'
          ? walletKey(card.userId, card.currency)
          : cardKey(card.id, card.currency)
        : systemKey('card-clearing', card.currency);
      if (
        refund
          ? auth.refunded.add(amount).gt(auth.settled)
          : auth.settled.add(amount).add(auth.released).gt(auth.amount)
      )
        throw new ProviderError(false, 409);
      const reference = `sudo:${type}:${id}`;
      if (!(await tx.financeJournal.findUnique({ where: { reference } }))) {
        await this.ledger.post(tx, reference, refund ? 'Card refund' : 'Card purchase settled', [
          {
            key: source,
            currency: card.currency,
            kind: refund ? 'CLEARING' : 'HOLD',
            ...(refund ? {} : { userId: card.userId }),
            amount: amount.negated(),
          },
          {
            key: destination,
            currency: card.currency,
            kind: refund ? (card.status === 'CANCELLED' ? 'WALLET' : 'CARD') : 'CLEARING',
            ...(refund ? { userId: card.userId } : {}),
            amount,
          },
        ]);
        await tx.financeAuthorization.update({
          where: { id: auth.id },
          data: refund
            ? { refunded: { increment: amount } }
            : {
                settled: { increment: amount },
                status: auth.settled.add(amount).add(auth.released).equals(auth.amount)
                  ? 'SETTLED'
                  : 'HELD',
              },
        });
        if (!refund)
          await tx.card.update({
            where: { id: card.id },
            data: { totalSpent: { increment: amount } },
          });
        if (refund && card.status !== 'CANCELLED')
          await tx.card.update({
            where: { id: card.id },
            data: { balance: { increment: amount } },
          });
        await this.project(
          tx,
          card.userId,
          refund ? 'DEPOSIT' : 'PAYMENT',
          amount,
          card.currency,
          reference,
          card.id,
        );
        if (!refund) await this.budgetAlerts(tx, card, amount);
      }
      await tx.financeInbox.update({ where: { id: inboxId }, data: { status: 'PROCESSED' } });
    });
  }
  private async budgetAlerts(tx: Prisma.TransactionClient, card: Card, amount: Prisma.Decimal) {
    if (
      !card.monthlyLimit ||
      !(card.notifyHalfSpent || card.notifyLowBalance || card.notifyBudgetReached)
    )
      return;
    const now = new Date();
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const totals = await tx.transaction.aggregate({
      where: {
        userId: card.userId,
        cardId: card.id,
        type: 'PAYMENT',
        status: 'SUCCESS',
        currency: card.currency,
        metadata: { path: ['live'], equals: true },
        createdAt: { gte: month },
      },
      _sum: { amount: true },
    });
    const spent = totals._sum.amount ?? new Prisma.Decimal(0);
    for (const title of budgetAlertTitles(card, spent.sub(amount), amount)) {
      await tx.notification.create({
        data: {
          id: randomUUID(),
          userId: card.userId,
          type: 'CARD',
          title,
          content: `${card.nickname || 'Virtual card'}: ${spent.toFixed(2)} of ${card.monthlyLimit.toFixed(2)} ${card.currency} this month.`,
          metadata: {
            action: 'finance.card.budget',
            entityType: 'card',
            entityId: card.id,
            live: true,
          },
        },
      });
    }
  }

  private async project(
    tx: Prisma.TransactionClient,
    userId: string,
    type: 'DEPOSIT' | 'PAYMENT',
    amount: Prisma.Decimal,
    currency: string,
    reference: string,
    cardId: string | null,
    extra: Record<string, string> = {},
  ) {
    // Existing feeds use Transaction; the immutable journal remains the financial authority.
    const account = await tx.account.findUniqueOrThrow({ where: { userId } });
    const wallet = await tx.wallet.findFirstOrThrow({ where: { accountId: account.id } });
    await tx.transaction.create({
      data: {
        id: randomUUID(),
        userId,
        walletId: wallet.id,
        type,
        status: 'SUCCESS',
        approvalStatus: 'APPROVED',
        amount,
        currency,
        cardId,
        description: type === 'PAYMENT' ? 'Card purchase' : 'Funds received',
        metadata: { live: true, reference, ...extra },
      },
    });
    await tx.notification.create({
      data: {
        id: randomUUID(),
        userId,
        type: 'TRANSACTION',
        title: type === 'PAYMENT' ? 'Purchase settled' : 'Funds received',
        content: `${amount.toFixed(2)} ${currency}`,
        metadata: { live: true, reference, ...extra },
      },
    });
  }
}
