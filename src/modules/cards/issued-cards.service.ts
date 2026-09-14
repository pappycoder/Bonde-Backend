import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationType,
  Prisma,
  CardStatus,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { money } from '../../common/money/money.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { FlutterwaveCardsService } from '../flutterwave/flutterwave-cards.service.js';
import { throwFlutterwaveHttp } from '../flutterwave/flutterwave.errors.js';

const DECIMAL_PATTERN = /^\d+(\.\d{1,2})?$/;

const CURRENCY = 'NGN';

/**
 * Orchestrates Flutterwave-issued cards against the DB + wallet movements.
 * Business logic lives in `FlutterwaveCardsService`; this module handles
 * ownership, balance guarding, idempotent `provider_events` sinks, and
 * notifications.
 */
@Injectable()
export class IssuedCardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fwCards: FlutterwaveCardsService,
    private readonly activity: ActivityService,
  ) {}

  async issue(
    userId: string,
    dto: {
      amount: string;
      nickname?: string;
      billingName?: string;
      billingAddress?: string;
      billingCity?: string;
      billingState?: string;
      billingPostalCode?: string;
      dateOfBirth?: string;
      gender?: string;
      title?: string;
      nameOnCard?: string;
    },
  ) {
    const profile = await this.prisma.profile.findUnique({ where: { id: userId } });
    if (!profile) throw new NotFoundException('Profile not found');
    const wallet = await this.prisma.wallet.findFirst({ where: { account: { userId } } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    const amount = new Prisma.Decimal(dto.amount);
    if (!DECIMAL_PATTERN.test(dto.amount) || amount.lte(0)) {
      throw new BadRequestException('amount must be a positive decimal');
    }
    if (new Prisma.Decimal(wallet.balance).lt(amount)) {
      throw new BadRequestException('Insufficient wallet balance');
    }

    const reference = `bonde_card_${randomUUID()}`;
    let eventId: string;
    try {
      eventId = await this.reserveEvent(reference, amount);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Card issuance already in progress');
      }
      throw error;
    }

    let issued;
    try {
      issued = await this.fwCards.issueCard({
        currency: CURRENCY,
        amount: Number(amount),
        debitCurrency: CURRENCY,
        billingName: dto.billingName ?? profile.fullName,
        billingAddress: dto.billingAddress ?? '',
        billingCity: dto.billingCity ?? '',
        billingState: dto.billingState ?? '',
        billingPostalCode: dto.billingPostalCode ?? '',
        firstName: profile.fullName.split(/\s+/)[0],
        lastName: profile.fullName.split(/\s+/).slice(1).join(' '),
        email: profile.email,
        ...(profile.phone ? { phone: profile.phone } : {}),
        ...(dto.dateOfBirth ? { date_of_birth: dto.dateOfBirth } : {}),
        ...(dto.gender ? { gender: dto.gender } : {}),
        ...(dto.title ? { title: dto.title } : {}),
        callbackUrl: undefined,
      });
    } catch (error) {
      await this.prisma.providerEvent
        .update({ where: { id: eventId }, data: { status: 'FAILED', processedAt: new Date() } })
        .catch(() => undefined);
      throwFlutterwaveHttp(error);
    }

    if (!issued.cardNumberEncrypted) {
      await this.prisma.providerEvent
        .update({ where: { id: eventId }, data: { status: 'FAILED', processedAt: new Date() } })
        .catch(() => undefined);
      throw new BadRequestException('Provider did not return card credentials');
    }

    const {
      cardNumberEncrypted,
      cardCvvEncrypted,
      cardNumberLast4,
      currency,
      nameOnCard,
      status,
      expirationDate,
      providerCardId,
    } = issued;

    const provider = await this.prisma.cardProvider.findFirst({ where: { isActive: true } });
    if (!provider) throw new NotFoundException('No card provider is configured');

    const cardId = randomUUID();
    const transactionId = randomUUID();
    const [card, tx] = await this.prisma.$transaction(async (tx) => {
      const created = await tx.card.create({
        data: {
          id: cardId,
          userId,
          providerId: provider.id,
          cardNumberEncrypted,
          cardCvvEncrypted,
          cardNumberLast4,
          cardType: 'virtual',
          issuer: 'flutterwave',
          currency,
          nameOnCard,
          status: status === 'ACTIVE' ? CardStatus.ACTIVE : CardStatus.PAUSED,
          balance: money(amount),
          expirationType: 'yearly',
          expirationDate,
          externalReferenceId: providerCardId,
        },
      });
      const createdTransaction = await tx.transaction.create({
        data: {
          id: transactionId,
          userId,
          walletId: wallet.id,
          cardId,
          type: TransactionType.TRANSFER,
          status: TransactionStatus.SUCCESS,
          amount: money(amount),
          currency: CURRENCY,
          description: `Virtual card prefund`,
        },
      });
      const walletUpdate = await tx.wallet.updateMany({
        where: { id: wallet.id, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (walletUpdate.count === 0) {
        throw new BadRequestException('Insufficient wallet balance');
      }
      return [created, createdTransaction] as const;
    });

    await this.prisma.providerEvent.update({
      where: { id: eventId },
      data: { status: 'PROCESSED', transactionId: tx.id, processedAt: new Date() },
    });

    await this.recordHistory(cardId, 'create');
    await this.activity.record({
      userId,
      action: 'card.flw.create',
      entityType: 'card',
      entityId: cardId,
      notify: {
        type: NotificationType.CARD,
        title: 'Virtual card created',
        content: `A virtual card ending in ${issued.cardNumberLast4} was created with a ${money(amount)} ${CURRENCY} prefund.`,
      },
    });

    return this.toView(card);
  }

  async fund(userId: string, cardId: string, amount: string) {
    const card = await this.assertIssuedCard(userId, cardId);
    const amountDecimal = new Prisma.Decimal(amount);
    if (!DECIMAL_PATTERN.test(amount) || amountDecimal.lte(0)) {
      throw new BadRequestException('amount must be a positive decimal');
    }

    const wallet = await this.prisma.wallet.findFirst({ where: { account: { userId } } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    // Guard first, then fund — if the provider call fails the debit is reversed.
    const updated = await this.prisma
      .$transaction(async (tx) => {
        const result = await tx.wallet.updateMany({
          where: { id: wallet.id, balance: { gte: amountDecimal } },
          data: { balance: { decrement: amountDecimal } },
        });
        if (result.count === 0) {
          throw new BadRequestException('Insufficient wallet balance');
        }
        const funded = await this.fwCards.fundCard({
          providerCardId: card.externalReferenceId!,
          amount,
        });
        const cardUpdate = await tx.card.update({
          where: { id: cardId },
          data: {
            balance: funded.balance,
          },
        });
        const transaction = await tx.transaction.create({
          data: {
            id: randomUUID(),
            userId,
            walletId: wallet.id,
            cardId,
            type: TransactionType.TRANSFER,
            status: TransactionStatus.SUCCESS,
            amount,
            currency: CURRENCY,
            description: `Virtual card fund`,
          },
        });
        return { card: cardUpdate, transaction };
      })
      .catch(async (error) => {
        // Provider call may have failed — recredit the wallet.
        if (error && typeof error === 'object' && 'code' in error) {
          await this.prisma.wallet
            .update({ where: { id: wallet.id }, data: { balance: { increment: amountDecimal } } })
            .catch(() => undefined);
        }
        throwFlutterwaveHttp(error);
      });

    await this.activity.record({
      userId,
      action: 'card.fund',
      entityType: 'card',
      entityId: cardId,
      notify: {
        type: NotificationType.CARD,
        title: 'Card funded',
        content: `Your virtual card ending in ${card.cardNumberLast4} was funded with ${amount} ${CURRENCY}.`,
      },
    });

    return this.toView(updated.card);
  }

  async withdraw(userId: string, cardId: string, amount: string) {
    const card = await this.assertIssuedCard(userId, cardId);
    const amountDecimal = new Prisma.Decimal(amount);
    if (!DECIMAL_PATTERN.test(amount) || amountDecimal.lte(0)) {
      throw new BadRequestException('amount must be a positive decimal');
    }
    if (new Prisma.Decimal(card.balance).lt(amountDecimal)) {
      throw new BadRequestException('Insufficient card balance');
    }

    const wallet = await this.prisma.wallet.findFirst({ where: { account: { userId } } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    let result;
    try {
      result = await this.fwCards.withdrawFromCard(card.externalReferenceId!, amount);
    } catch (error) {
      throwFlutterwaveHttp(error);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const cardUpdate = await tx.card.update({
        where: { id: cardId },
        data: { balance: result.balance },
      });
      const transaction = await tx.transaction.create({
        data: {
          id: randomUUID(),
          userId,
          walletId: wallet.id,
          cardId,
          type: TransactionType.TRANSFER,
          status: TransactionStatus.SUCCESS,
          amount,
          currency: CURRENCY,
          description: `Virtual card withdrawal`,
        },
      });
      await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: amountDecimal } },
      });
      return { card: cardUpdate, transaction };
    });

    await this.activity.record({
      userId,
      action: 'card.withdraw',
      entityType: 'card',
      entityId: cardId,
      notify: {
        type: NotificationType.CARD,
        title: 'Card withdrawal',
        content: `${amount} ${CURRENCY} was withdrawn from your virtual card ending in ${card.cardNumberLast4}.`,
      },
    });

    return this.toView(updated.card);
  }

  async cancel(userId: string, cardId: string) {
    const card = await this.assertIssuedCard(userId, cardId);
    if (new Prisma.Decimal(card.balance).gt(0)) {
      throw new BadRequestException('Card balance must be zero before cancelling');
    }

    await this.fwCards.terminateCard(card.externalReferenceId!);

    const updated = await this.prisma.card.update({
      where: { id: cardId },
      data: { status: CardStatus.CANCELLED },
    });
    await this.recordHistory(cardId, 'cancel');
    await this.activity.record({
      userId,
      action: 'card.terminate',
      entityType: 'card',
      entityId: cardId,
      notify: {
        type: NotificationType.CARD,
        title: 'Card cancelled',
        content: `Your virtual card ending in ${card.cardNumberLast4} was cancelled.`,
      },
    });
    return this.toView(updated);
  }

  async pause(userId: string, cardId: string) {
    const card = await this.assertIssuedCard(userId, cardId);
    if (card.status === CardStatus.CANCELLED) {
      throw new BadRequestException('Cannot pause a cancelled card');
    }
    await this.fwCards.blockCard(card.externalReferenceId!);
    const updated = await this.prisma.card.update({
      where: { id: cardId },
      data: { status: CardStatus.PAUSED },
    });
    await this.recordHistory(cardId, 'pause');
    return this.toView(updated);
  }

  async resume(userId: string, cardId: string) {
    const card = await this.assertIssuedCard(userId, cardId);
    if (card.status === CardStatus.CANCELLED) {
      throw new BadRequestException('Cannot resume a cancelled card');
    }
    await this.fwCards.unblockCard(card.externalReferenceId!);
    const updated = await this.prisma.card.update({
      where: { id: cardId },
      data: { status: CardStatus.ACTIVE },
    });
    await this.recordHistory(cardId, 'resume');
    return this.toView(updated);
  }

  async syncTransactions(userId: string, cardId: string) {
    const card = await this.assertIssuedCard(userId, cardId);
    if (!card.externalReferenceId) {
      throw new BadRequestException('Card has no provider reference');
    }

    const wallet = await this.prisma.wallet.findFirst({ where: { account: { userId } } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    const providerTxns = await this.fwCards.listCardTransactions(card.externalReferenceId);
    let newSpends = 0;

    for (const txn of providerTxns) {
      const eventRef = `flutterwave:card.txn:${txn.id}`;
      try {
        const eventId = randomUUID();
        await this.prisma.providerEvent.create({
          data: {
            id: eventId,
            provider: 'flutterwave',
            reference: eventRef,
            eventType: 'card.sync',
            status: 'PROCESSED',
            payload: txn as unknown as Prisma.InputJsonValue,
          },
        });
        await this.prisma.transaction.create({
          data: {
            id: randomUUID(),
            userId,
            walletId: wallet.id,
            cardId,
            type: TransactionType.PAYMENT,
            status:
              txn.status === 'successful' ? TransactionStatus.SUCCESS : TransactionStatus.FAIL,
            amount: money(txn.amount),
            currency: txn.currency,
            description: txn.narration ?? `Card transaction ${txn.id}`,
          },
        });
        await this.prisma.card.update({
          where: { id: cardId },
          data: { totalSpent: { increment: money(txn.amount) } },
        });
        newSpends += 1;
        await this.activity.record({
          userId,
          action: 'card.transactions.sync',
          entityType: 'card',
          entityId: cardId,
          notify: {
            type: NotificationType.CARD,
            title: 'Card spend recorded',
            content: `A card transaction of ${money(txn.amount)} ${txn.currency} was recorded.`,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          continue;
        }
      }
    }

    const refreshed = await this.fwCards.getCard(card.externalReferenceId);
    await this.prisma.card.update({
      where: { id: cardId },
      data: { lastSyncAt: new Date(), balance: refreshed.balance },
    });

    return {
      lastSyncAt: new Date(),
      newSpends,
      balance: refreshed.balance,
    };
  }

  private async assertIssuedCard(userId: string, cardId: string) {
    const card = await this.prisma.card.findFirst({ where: { id: cardId, userId } });
    if (!card || card.issuer !== 'flutterwave') {
      throw new NotFoundException('Card not found');
    }
    return card;
  }

  private async reserveEvent(reference: string, amount: Prisma.Decimal): Promise<string> {
    const id = randomUUID();
    await this.prisma.providerEvent.create({
      data: {
        id,
        provider: 'flutterwave',
        reference,
        eventType: 'card.issue',
        status: 'RECEIVED',
        payload: { amount: money(amount), currency: CURRENCY },
      },
    });
    return id;
  }

  private async recordHistory(cardId: string, event: string) {
    await this.prisma.cardHistory.create({
      data: { id: randomUUID(), cardId, event, changes: {} },
    });
  }

  private toView(card: {
    id: string;
    userId: string;
    providerId: string;
    cardNumberEncrypted: string | null;
    cardCvvEncrypted: string | null;
    cardNumberLast4: string;
    cardType: string;
    issuer: string;
    currency: string;
    nameOnCard: string | null;
    status: CardStatus;
    nickname: string | null;
    maxSpendLimit: Prisma.Decimal | null;
    monthlyLimit: Prisma.Decimal | null;
    totalSpent: Prisma.Decimal;
    balance: Prisma.Decimal;
    expirationType: string;
    expirationDate: Date;
    externalReferenceId: string | null;
    lastSyncAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const { cardNumberEncrypted: _p, cardCvvEncrypted: _c, ...rest } = card;
    return {
      ...rest,
      maxSpendLimit: card.maxSpendLimit === null ? null : money(card.maxSpendLimit),
      monthlyLimit: card.monthlyLimit === null ? null : money(card.monthlyLimit),
      totalSpent: money(card.totalSpent),
      balance: money(card.balance),
    };
  }
}
