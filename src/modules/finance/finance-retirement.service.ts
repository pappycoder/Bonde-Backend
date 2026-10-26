import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Card, type FinanceOperation } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FinancePolicy } from './finance-policy.service.js';
import { fingerprint, cardKey, walletKey } from './finance.types.js';
import { LedgerService } from './ledger.service.js';
import { SudoClient, object } from './providers.js';
import { projectAllocationReturn } from './finance-projections.js';

@Injectable()
export class FinanceRetirement {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: FinancePolicy,
    private readonly ledger: LedgerService,
    private readonly sudo: SudoClient,
  ) {}
  async mark(tx: Prisma.TransactionClient, card: Card, reason: string, enqueue = true) {
    if (!card.retiredAt) {
      await tx.card.update({
        where: { id: card.id },
        data: { retiredAt: new Date(), retirementReason: reason, retirementStatus: 'RETIRING' },
      });
      await tx.auditLog.create({
        data: {
          id: randomUUID(),
          userId: card.userId,
          action: 'finance.card.retire',
          entityType: 'card',
          entityId: card.id,
          metadata: { reason },
        },
      });
      await tx.notification.create({
        data: {
          id: randomUUID(),
          userId: card.userId,
          type: 'CARD',
          title: 'Card permanently retired',
          content: `${card.nickname || 'Virtual card'} can no longer authorize purchases. Remaining funds return after pending purchases resolve.`,
          metadata: { entityType: 'card', entityId: card.id, live: true },
        },
      });
    }
    if (enqueue) await this.enqueue(tx, card, reason);
  }
  private async enqueue(tx: Prisma.TransactionClient, card: Card, reason: string) {
    const existing = await tx.financeOperation.findFirst({
      where: { cardId: card.id, kind: 'RETIRE', status: { notIn: ['FAILED', 'SUPERSEDED'] } },
    });
    if (existing) return;
    const key = `retire_${card.id}`;
    await tx.financeOperation.upsert({
      where: { userId_idempotencyKey: { userId: card.userId, idempotencyKey: key } },
      create: {
        id: randomUUID(),
        userId: card.userId,
        cardId: card.id,
        idempotencyKey: key,
        fingerprint: fingerprint({ cardId: card.id, reason }),
        kind: 'RETIRE',
        currency: card.currency,
        amount: 0,
        fee: 0,
        request: { reason },
      },
      update: { status: 'QUEUED', leaseUntil: null },
    });
  }
  async ensureDue(userId: string, cardId: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM profiles WHERE id=${userId}::uuid FOR UPDATE`;
      const card = await tx.card.findFirst({ where: { id: cardId, userId, issuer: 'sudo' } });
      if (!card) throw new NotFoundException('Card not found');
      if (card.status === 'CANCELLED') return;
      const snapshot = await this.policy.snapshot(tx, card);
      if (snapshot.reason) await this.mark(tx, card, snapshot.reason);
    });
  }
  async scan() {
    const due = await this.prisma.card.findMany({
      where: {
        issuer: 'sudo',
        status: { not: 'CANCELLED' },
        OR: [
          { retiredAt: null, expirationDate: { lte: new Date() } },
          { retiredAt: null, controlExpiresAt: { lte: new Date() } },
          {
            retiredAt: { not: null },
            retirementStatus: 'RETIRING',
            financeOperations: {
              none: { kind: 'RETIRE', status: { notIn: ['FAILED', 'SUPERSEDED'] } },
            },
          },
        ],
      },
      take: 100,
      orderBy: { updatedAt: 'asc' },
    });
    for (const card of due) await this.ensureDue(card.userId, card.id);
    return due.length;
  }
  /** Serializes all provider lifecycle writes, independently of operation leases. */
  async lease(cardId: string, operationId: string) {
    const claimed = await this.prisma.card.updateMany({
      where: {
        id: cardId,
        OR: [{ providerLeaseUntil: null }, { providerLeaseUntil: { lt: new Date() } }],
      },
      data: { providerLeaseOwner: operationId, providerLeaseUntil: new Date(Date.now() + 60000) },
    });
    if (!claimed.count) throw new ConflictException('Another provider action is processing');
  }
  async release(cardId: string, operationId: string) {
    await this.prisma.card.updateMany({
      where: { id: cardId, providerLeaseOwner: operationId },
      data: { providerLeaseOwner: null, providerLeaseUntil: null },
    });
  }
  async process(op: FinanceOperation) {
    await this.lease(op.cardId!, op.id);
    try {
      const card = await this.prisma.card.findUniqueOrThrow({ where: { id: op.cardId! } });
      if (!card.retiredAt || !card.externalReferenceId)
        throw new ConflictException('Retirement is waiting for card provisioning');
      // Read provider truth before retrying. Normal retirement never reports a card lost/stolen.
      let remote = object(
        await this.sudo.call(`/cards/${encodeURIComponent(card.externalReferenceId)}`),
      );
      if (remote._id !== card.externalReferenceId) throw new Error('Provider card mismatch');
      if (remote.status === 'active') {
        await this.sudo.call(`/cards/${encodeURIComponent(card.externalReferenceId)}`, 'PUT', {
          status: 'inactive',
        });
        remote = object(
          await this.sudo.call(`/cards/${encodeURIComponent(card.externalReferenceId)}`),
        );
      }
      if (
        remote._id !== card.externalReferenceId ||
        !['inactive', 'canceled'].includes(String(remote.status))
      )
        throw new Error('Provider deactivation not confirmed');
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM profiles WHERE id=${op.userId}::uuid FOR UPDATE`;
        const current = await tx.card.findUniqueOrThrow({ where: { id: card.id } });
        if (!current.retiredAt) throw new Error('Missing permanent retirement marker');
        const [held, unresolved] = await Promise.all([
          tx.financeAuthorization.count({ where: { cardId: card.id, status: 'HELD' } }),
          tx.financeInbox.count({ where: { cardId: card.id, status: { not: 'PROCESSED' } } }),
        ]);
        await tx.card.update({
          where: { id: card.id },
          data: { status: remote.status === 'canceled' ? 'CANCELLED' : 'PAUSED' },
        });
        if (held || unresolved) {
          await tx.financeOperation.update({
            where: { id: op.id },
            data: {
              status: 'PENDING',
              leaseUntil: null,
              result: { reason: 'WAITING_FOR_SETTLEMENT', providerStatus: String(remote.status) },
            },
          });
          return;
        }
        const allocation = await tx.financeAccount.findUnique({
          where: { key: cardKey(card.id, card.currency) },
        });
        if (allocation?.balance.gt(0)) {
          await this.ledger.post(tx, `retire:${card.id}`, 'Retired card allocation returned', [
            {
              key: allocation.key,
              userId: card.userId,
              currency: card.currency,
              kind: 'CARD',
              amount: allocation.balance.negated(),
            },
            {
              key: walletKey(card.userId, card.currency),
              userId: card.userId,
              currency: card.currency,
              kind: 'WALLET',
              amount: allocation.balance,
            },
          ]);
          await projectAllocationReturn(tx, {
            userId: card.userId,
            cardId: card.id,
            currency: card.currency,
            amount: allocation.balance,
            reference: `retire:${card.id}`,
            operationId: op.id,
          });
        }
        await tx.card.update({
          where: { id: card.id },
          data: {
            retirementStatus: remote.status === 'canceled' ? 'CLOSED' : 'RETIRED',
            balance: 0,
          },
        });
        await tx.financeOperation.update({
          where: { id: op.id },
          data: {
            status: 'SUCCEEDED',
            leaseUntil: null,
            result: {
              providerStatus: String(remote.status),
              providerCancellation:
                remote.status === 'canceled' ? 'CONFIRMED' : 'UNSUPPORTED_NORMAL_REASON',
            },
          },
        });
        await tx.cardHistory.create({
          data: {
            id: randomUUID(),
            cardId: card.id,
            event: 'retired',
            changes: { reason: current.retirementReason, providerStatus: String(remote.status) },
          },
        });
      });
    } catch {
      await this.prisma.financeOperation.update({
        where: { id: op.id },
        data: {
          status: 'UNKNOWN',
          leaseUntil: null,
          result: { reason: 'DEACTIVATION_OR_RECONCILIATION_REQUIRED' },
        },
      });
    } finally {
      await this.release(op.cardId!, op.id);
    }
  }
}
