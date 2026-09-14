import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationType,
  Prisma,
  ProviderEventStatus,
  TransactionStatus,
  TransactionType,
  ThresholdType,
} from '@prisma/client';
import { Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { money } from '../../common/money/money.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { FLUTTERWAVE_CLIENT, type FlutterwaveGateway } from '../flutterwave/flutterwave.client.js';
import type { TransferDisburseData } from '../flutterwave/flutterwave.types.js';
import type { WebhookHandledResult, WithdrawalRequestInput } from './funding.types.js';

const CURRENCY = 'NGN';

/**
 * Wallet withdrawals. Money is **reserved at initiate**: the wallet is debited
 * the instant the request is accepted (guarded `decrement`), then the payout is
 * sent to Flutterwave. A failed payout is refunded back into the wallet on the
 * `transfer.disburse`/`transfer.reversal` webhook. Replays are handled by the
 * `provider_events.[provider,reference]` constraint; refunds are replay-safe
 * because they only fire while the withdrawal transaction is still PENDING.
 */
@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    @Inject(FLUTTERWAVE_CLIENT) private readonly client: FlutterwaveGateway,
  ) {}

  /**
   * Initiate a withdrawal. Throws HttpException on a hard (synchronous)
   * provider failure after reserving, in which case the reservation is refunded
   * and the transaction marked FAIL.
   */
  async request(userId: string, dto: WithdrawalRequestInput) {
    const currency = dto.currency ?? CURRENCY;
    const amount = this.moneyOf(dto.amount);

    const wallet = await this.prisma.wallet.findFirst({ where: { account: { userId } } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    if (!amount || amount.lte(0)) {
      throw new BadRequestException('amount must be a positive decimal');
    }
    if (currency !== wallet.currency) {
      throw new BadRequestException(`Wallet is ${wallet.currency}; withdrawals must match`);
    }

    const inFlight = await this.prisma.transaction.findFirst({
      where: { userId, type: TransactionType.WITHDRAWAL, status: TransactionStatus.PENDING },
    });
    if (inFlight) {
      throw new ConflictException('A withdrawal is already in progress');
    }

    const thresholdWarning = await this.computeThresholdWarning(userId, amount);

    const reference = `bonde_wd_${randomUUID()}`;
    const { transactionId, eventId } = await this.reserve(
      userId,
      wallet.id,
      amount,
      currency,
      reference,
      thresholdWarning,
    );

    try {
      await this.client.initiateTransfer({
        accountBank: dto.bankCode,
        accountNumber: dto.accountNumber,
        amount: Number(amount),
        currency,
        reference,
        narration: dto.narration ?? 'Bonde wallet withdrawal',
        debitCurrency: CURRENCY,
      });
    } catch (error) {
      await this.refundAfterHardFailure(eventId, transactionId, userId);
      throw new BadGatewayException(
        error instanceof Error ? error.message : 'Withdrawal initiation failed',
      );
    }

    await this.activity.record({
      userId,
      action: 'wallet.withdrawal',
      entityType: 'transaction',
      entityId: transactionId,
      metadata: { reference },
      notify: {
        type: NotificationType.TRANSACTION,
        title: 'Withdrawal initiated',
        content: `A withdrawal of ${money(amount)} ${currency} is being processed.`,
      },
    });
    return {
      id: transactionId,
      amount: money(amount),
      currency,
      status: TransactionStatus.PENDING,
    };
  }

  /** `transfer.disburse` — marks SUCCESS on SUCCESSFUL, refunds on FAILED. */
  async handleTransferDisburse(data: TransferDisburseData): Promise<WebhookHandledResult> {
    return this.handleOutcome(data, 'transfer.disburse');
  }

  /** `transfer.reversal` — the payout was reversed; refund the reservation. */
  async handleTransferReversal(data: TransferDisburseData): Promise<WebhookHandledResult> {
    return this.handleOutcome({ ...data, status: 'FAILED' }, 'transfer.reversal');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async handleOutcome(
    data: TransferDisburseData,
    eventType: string,
  ): Promise<WebhookHandledResult> {
    const reference = `flutterwave:${eventType}:${data.id}`;

    let eventId: string;
    try {
      eventId = await this.recordReceived(eventType, reference, data);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { status: 'duplicate', reference };
      }
      throw error;
    }

    const reserve = await this.prisma.providerEvent.findFirst({
      where: {
        provider: 'flutterwave',
        reference: data.reference ?? '',
        eventType: 'withdraw.reserve',
      },
    });
    if (!reserve?.transactionId) {
      await this.failEvent(eventId);
      return { status: 'ignored', reference };
    }

    const transaction = await this.prisma.transaction.findUnique({
      where: { id: reserve.transactionId },
    });
    if (!transaction || transaction.status !== TransactionStatus.PENDING) {
      await this.markHandled(eventId, reserve.transactionId);
      return { status: 'ignored', reference };
    }

    if (data.status === 'SUCCESSFUL') {
      await this.markSuccess(eventId, reserve.transactionId, transaction);
      await this.activity
        .record({
          userId: transaction.userId,
          action: 'wallet.withdrawal',
          entityType: 'transaction',
          entityId: transaction.id,
          metadata: { reference, outcome: 'SUCCESSFUL' },
          notify: {
            type: NotificationType.TRANSACTION,
            title: 'Withdrawal successful',
            content: `Your withdrawal of ${money(transaction.amount)} ${transaction.currency} was sent to the destination bank account.`,
          },
        })
        .catch(() => undefined);
    } else {
      await this.refund(eventId, reserve.transactionId, transaction);
      await this.activity
        .record({
          userId: transaction.userId,
          action: 'wallet.withdrawal',
          entityType: 'transaction',
          entityId: transaction.id,
          metadata: { reference, outcome: 'FAILED' },
          notify: {
            type: NotificationType.TRANSACTION,
            title: 'Withdrawal failed',
            content: `Your withdrawal of ${money(transaction.amount)} ${transaction.currency} failed and was refunded to your wallet.`,
          },
        })
        .catch(() => undefined);
    }

    return { status: 'processed', reference };
  }

  private async reserve(
    userId: string,
    walletId: string,
    amount: Prisma.Decimal,
    currency: string,
    reference: string,
    thresholdWarning: boolean,
  ): Promise<{ transactionId: string; eventId: string }> {
    const transactionId = randomUUID();
    const eventId = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.providerEvent.create({
        data: {
          id: eventId,
          provider: 'flutterwave',
          reference,
          eventType: 'withdraw.reserve',
          status: ProviderEventStatus.RECEIVED,
          payload: { amount: money(amount), currency, walletId },
        },
      });
      await tx.transaction.create({
        data: {
          id: transactionId,
          userId,
          walletId,
          type: TransactionType.WITHDRAWAL,
          status: TransactionStatus.PENDING,
          amount: money(amount),
          currency,
          description: `Withdrawal to external account`,
          thresholdWarning,
        },
      });
      // Guarded decrement: only succeeds while the wallet actually covers the
      // amount; otherwise the whole reservation rolls back.
      const result = await tx.wallet.updateMany({
        where: { id: walletId, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (result.count === 0) {
        throw new BadRequestException('Insufficient wallet balance');
      }
    });

    await this.prisma.providerEvent.update({
      where: { id: eventId },
      data: {
        status: ProviderEventStatus.PROCESSED,
        transactionId,
        processedAt: new Date(),
      },
    });
    return { transactionId, eventId };
  }

  private async refundAfterHardFailure(
    eventId: string,
    transactionId: string,
    userId: string,
  ): Promise<void> {
    const transaction = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!transaction || transaction.status === TransactionStatus.FAIL) return;

    const wallet = await this.prisma.wallet.findFirst({ where: { account: { userId } } });
    if (!wallet) return;

    await this.prisma.$transaction([
      this.prisma.transaction.update({
        where: { id: transactionId },
        data: { status: TransactionStatus.FAIL },
      }),
      this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: transaction.amount } },
      }),
      this.prisma.providerEvent.update({
        where: { id: eventId },
        data: { status: ProviderEventStatus.FAILED, processedAt: new Date() },
      }),
    ]);
  }

  private async refund(
    eventId: string,
    transactionId: string,
    transaction: {
      userId: string;
      walletId: string;
      amount: Prisma.Decimal;
    },
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.transaction.update({
        where: { id: transactionId },
        data: { status: TransactionStatus.FAIL },
      }),
      this.prisma.wallet.update({
        where: { id: transaction.walletId },
        data: { balance: { increment: transaction.amount } },
      }),
      this.prisma.providerEvent.update({
        where: { id: eventId },
        data: { status: ProviderEventStatus.PROCESSED, transactionId, processedAt: new Date() },
      }),
    ]);
    this.logger.log(`Refunded failed withdrawal ${transactionId}`);
  }

  private async markSuccess(
    eventId: string,
    transactionId: string,
    _transaction: {
      userId: string;
      walletId: string;
    },
  ): Promise<void> {
    await this.prisma.providerEvent.update({
      where: { id: eventId },
      data: { status: ProviderEventStatus.PROCESSED, transactionId, processedAt: new Date() },
    });
    await this.prisma.transaction.update({
      where: { id: transactionId },
      data: { status: TransactionStatus.SUCCESS },
    });
  }

  private async markHandled(eventId: string, transactionId: string): Promise<void> {
    await this.prisma.providerEvent
      .update({
        where: { id: eventId },
        data: {
          status: ProviderEventStatus.PROCESSED,
          transactionId,
          processedAt: new Date(),
        },
      })
      .catch(() => undefined);
  }

  private async recordReceived(
    eventType: string,
    reference: string,
    payload: unknown,
  ): Promise<string> {
    const id = randomUUID();
    await this.prisma.providerEvent.create({
      data: {
        id,
        provider: 'flutterwave',
        reference,
        eventType,
        status: ProviderEventStatus.RECEIVED,
        payload: payload as Prisma.InputJsonValue,
      },
    });
    return id;
  }

  private async failEvent(eventId: string): Promise<void> {
    await this.prisma.providerEvent
      .update({
        where: { id: eventId },
        data: { status: ProviderEventStatus.FAILED, processedAt: new Date() },
      })
      .catch(() => undefined);
  }

  private moneyOf(value: string): Prisma.Decimal {
    return new Prisma.Decimal(value);
  }

  private async computeThresholdWarning(userId: string, amount: Prisma.Decimal): Promise<boolean> {
    const [firstTime, large] = await Promise.all([
      this.prisma.transaction.count({
        where: {
          userId,
          type: TransactionType.WITHDRAWAL,
          status: TransactionStatus.SUCCESS,
        },
      }),
      this.prisma.transactionThreshold.findMany({
        where: { userId, isActive: true, thresholdType: ThresholdType.LARGE_AMOUNT },
      }),
    ]);

    if (firstTime === 0) return true;
    return large.some((threshold) => amount.gte(threshold.thresholdValue));
  }
}
