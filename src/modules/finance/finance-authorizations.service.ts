import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LedgerService } from './ledger.service.js';
import { amountOf, cardKey, holdKey } from './finance.types.js';
import { object, string } from './providers.js';
import { policyDecision, validateRules } from './card-policy.js';
import { FinanceCapabilities } from './finance-capabilities.service.js';

@Injectable()
export class FinanceAuthorizations {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly capabilities: FinanceCapabilities,
  ) {}
  async authorize(raw: Record<string, unknown>) {
    try {
      const pending = object(raw.pendingRequest),
        merchant = object(raw.merchant),
        providerCard = object(raw.card);
      const id = string(raw._id),
        providerId = string(providerCard._id),
        currency = string(pending.currency);
      const amount = amountOf(String(pending.amount));
      this.capabilities.assertCurrency(currency as 'NGN' | 'USD');
      const merchantId = string(merchant.merchantId),
        mcc = string(merchant.category),
        merchantName = string(merchant.name);
      const responseCode = await this.prisma.$transaction(
        async (tx) => {
          const owner = await tx.card.findFirst({
            where: { issuer: 'sudo', externalReferenceId: providerId, currency },
          });
          if (!owner) return '05';
          // Every allocation, rule change and authorization uses the same owner lock.
          await tx.$queryRaw`SELECT id FROM profiles WHERE id=${owner.userId}::uuid FOR UPDATE`;
          const replay = await tx.financeAuthorization.findUnique({ where: { id } });
          if (replay)
            return replay.cardId === owner.id &&
              replay.amount.equals(amount) &&
              replay.merchantId === merchantId &&
              replay.currency === currency
              ? replay.responseCode
              : '05';
          const card = await tx.card.findUniqueOrThrow({
            where: { id: owner.id },
            include: {
              locks: { where: { isActive: true } },
              user: { include: { accounts: true } },
            },
          });
          const record = (code: string, status: string) =>
            tx.financeAuthorization.create({
              data: {
                id,
                userId: card.userId,
                cardId: card.id,
                currency,
                amount,
                status,
                merchantId,
                merchantName,
                mcc,
                responseCode: code,
              },
            });
          const pendingAction = await tx.financeOperation.count({
            where: {
              cardId: card.id,
              status: { in: ['QUEUED', 'PROCESSING', 'UNKNOWN'] },
              kind: { in: ['ISSUE', 'PAUSE', 'CANCEL'] },
            },
          });
          const customer = await tx.financeCustomer.findUnique({ where: { userId: card.userId } });
          if (
            card.status !== 'ACTIVE' ||
            card.expirationDate <= new Date() ||
            pendingAction ||
            customer?.status !== 'READY' ||
            !card.user.accounts.some((a) => a.isActive)
          ) {
            await record('05', 'DECLINED');
            return '05';
          }
          const monthStart = new Date(
            Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
          );
          const history = await tx.financeAuthorization.findMany({
            where: { cardId: card.id, status: { in: ['HELD', 'SETTLED'] } },
          });
          const usage = {
            uses: history.length,
            spent: history
              .filter((a) => a.createdAt >= monthStart)
              .reduce(
                (sum, a) => sum.add(a.status === 'HELD' ? a.amount.sub(a.released) : a.settled),
                new Prisma.Decimal(0),
              ),
          };
          for (const lock of card.locks) {
            const rule = validateRules(lock.config as Record<string, unknown>);
            if (policyDecision(rule, { amount, merchantId, mcc }, usage)) {
              await record('05', 'DECLINED');
              return '05';
            }
          }
          if (
            policyDecision(
              {
                maxSpendLimit: card.maxSpendLimit?.toFixed(2),
                monthlyLimit: card.monthlyLimit?.toFixed(2),
              },
              { amount, merchantId, mcc },
              usage,
            )
          ) {
            await record('05', 'DECLINED');
            return '05';
          }
          const available = await tx.financeAccount.findUnique({
            where: { key: cardKey(card.id, currency) },
          });
          if (!available || available.balance.lt(amount)) {
            await record('51', 'DECLINED');
            return '51';
          }
          const threshold = await tx.transactionThreshold.findUnique({
            where: { userId_thresholdType: { userId: card.userId, thresholdType: 'LARGE_AMOUNT' } },
          });
          const firstTime = await tx.transactionThreshold.findUnique({
            where: { userId_thresholdType: { userId: card.userId, thresholdType: 'FIRST_TIME' } },
          });
          const knownMerchant = await tx.financeAuthorization.count({
            where: { userId: card.userId, merchantId, status: { in: ['HELD', 'SETTLED'] } },
          });
          const needsApproval =
            (threshold?.isActive && amount.gt(threshold.thresholdValue)) ||
            (firstTime?.isActive && !knownMerchant);
          if (needsApproval) {
            const grant = await tx.financeAuthorization.findFirst({
              where: {
                userId: card.userId,
                cardId: card.id,
                currency,
                merchantId,
                amount,
                status: 'RETRY_APPROVED',
                approvalUsedAt: null,
                approvalExpiresAt: { gt: new Date() },
              },
            });
            if (!grant) {
              await record('05', 'AWAITING_APPROVAL');
              await tx.notification.create({
                data: {
                  id: randomUUID(),
                  userId: card.userId,
                  type: 'TRANSACTION',
                  title: 'Purchase needs approval',
                  content: `Approve ${amount.toFixed(2)} ${currency} at ${merchantName}, then retry at checkout.`,
                  metadata: { authorizationId: id, live: true },
                },
              });
              return '05';
            }
            await tx.financeAuthorization.update({
              where: { id: grant.id },
              data: { approvalUsedAt: new Date(), status: 'APPROVAL_USED' },
            });
          }
          await this.ledger.post(tx, `authorization:${id}`, 'Card purchase hold', [
            {
              key: cardKey(card.id, currency),
              currency,
              userId: card.userId,
              kind: 'CARD',
              amount: amount.negated(),
            },
            { key: holdKey(id, currency), currency, userId: card.userId, kind: 'HOLD', amount },
          ]);
          await tx.card.update({
            where: { id: card.id },
            data: { balance: { decrement: amount } },
          });
          await record('00', 'HELD');
          return '00';
        },
        { maxWait: 400, timeout: 2500 },
      );
      return { statusCode: responseCode === '00' ? 200 : 400, data: { responseCode } };
    } catch {
      return { statusCode: 400, data: { responseCode: '05' } };
    }
  }
}
