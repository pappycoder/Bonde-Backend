import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationType,
  Prisma,
  ProviderEventStatus,
  TransactionStatus,
  TransactionType,
  VirtualAccountStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { money } from '../../common/money/money.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import type { ChargeCompletedData } from '../flutterwave/flutterwave.types.js';
import type { WebhookHandledResult } from './funding.types.js';

/**
 * Applies `charge.completed` webhooks to wallet balances. Idempotency is the
 * `provider_events.[provider,reference]` unique constraint: a replayed or
 * duplicate webhook hits P2002 and is acked instead of double-credited.
 */
@Injectable()
export class DepositsService {
  private readonly logger = new Logger(DepositsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  async handleChargeCompleted(data: ChargeCompletedData): Promise<WebhookHandledResult> {
    const reference = `flutterwave:charge.completed:${data.id}`;

    let eventId: string;
    try {
      eventId = await this.recordReceived(reference, data);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { status: 'duplicate', reference };
      }
      throw error;
    }

    const txRef = data.txRef;
    const va = txRef ? await this.prisma.virtualAccount.findUnique({ where: { txRef } }) : null;
    const amount = this.amountOf(data);

    if (
      !va ||
      va.status !== VirtualAccountStatus.ACTIVE ||
      !amount ||
      amount.lte(0) ||
      data.currency !== va.currency
    ) {
      await this.failEvent(eventId, reference);
      return { status: 'ignored', reference };
    }

    const wallet = await this.prisma.wallet.findFirst({
      where: { account: { userId: va.userId } },
    });
    if (!wallet) {
      await this.failEvent(eventId, reference);
      return { status: 'ignored', reference };
    }

    const transactionId = randomUUID();
    const [transaction] = await this.prisma.$transaction([
      this.prisma.transaction.create({
        data: {
          id: transactionId,
          userId: va.userId,
          walletId: wallet.id,
          type: TransactionType.DEPOSIT,
          status: TransactionStatus.SUCCESS,
          amount: money(amount),
          currency: va.currency,
          description: `Wallet funding via ${va.bankName} ··· ${va.accountNumber}`,
        },
      }),
      this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: amount } },
      }),
    ]);
    await this.prisma.providerEvent.update({
      where: { id: eventId },
      data: {
        status: ProviderEventStatus.PROCESSED,
        transactionId: transaction.id,
        processedAt: new Date(),
      },
    });

    await this.activity
      .record({
        userId: va.userId,
        action: 'wallet.deposit',
        entityType: 'transaction',
        entityId: transaction.id,
        metadata: { reference: data.flwRef ?? data.id },
        notify: {
          type: NotificationType.TRANSACTION,
          title: 'Deposit received',
          content: `A deposit of ${money(amount)} ${va.currency} was added to your wallet.`,
        },
      })
      .catch(() => undefined);

    return { status: 'processed', reference };
  }

  private async recordReceived(reference: string, payload: unknown): Promise<string> {
    const id = randomUUID();
    await this.prisma.providerEvent.create({
      data: {
        id,
        provider: 'flutterwave',
        reference,
        eventType: 'charge.completed',
        status: ProviderEventStatus.RECEIVED,
        payload: payload as Prisma.InputJsonValue,
      },
    });
    return id;
  }

  private async failEvent(eventId: string, reference: string): Promise<void> {
    await this.prisma.providerEvent
      .update({
        where: { id: eventId },
        data: { status: ProviderEventStatus.FAILED, processedAt: new Date() },
      })
      .catch(() => undefined);
    this.logger.warn(`Ignoring charge.completed ${reference}`);
  }

  private amountOf(data: ChargeCompletedData): Prisma.Decimal | null {
    if (!data.amount || Number.isNaN(Number(data.amount))) return null;
    return new Prisma.Decimal(Number(data.amount));
  }
}
