import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AppConfig } from '../../config/configuration.js';
import { PasscodeService } from '../passcode/passcode.service.js';
import { CREDIT_PACKS, PREMIUM_MONTHLY } from './billing.catalog.js';
import { BillingOrderDto } from './billing.dto.js';

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passcode: PasscodeService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}
  catalog() {
    const settings = this.config.get('profileHub', { infer: true });
    return {
      premium: PREMIUM_MONTHLY,
      packs: CREDIT_PACKS,
      annual: null,
      billingEnabled: settings.billingEnabled,
      methods: { wallet: settings.billingEnabled, card: false, newCard: false },
      legal: {
        terms: settings.termsUrl,
        privacy: settings.privacyUrl,
        subscription: settings.subscriptionTermsUrl,
      },
    };
  }
  async summary(userId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "profiles" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      const profile = await tx.profile.findUnique({ where: { id: userId } });
      if (!profile) throw new NotFoundException('Profile not found');
      let credits = await tx.aiCreditAccount.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });
      if (credits.periodEnd && credits.periodEnd <= new Date() && credits.planRemaining > 0) {
        credits = await tx.aiCreditAccount.update({
          where: { userId },
          data: { planRemaining: 0 },
        });
      }
      const premium =
        profile.cardPlan === 'PREMIUM' &&
        (!profile.cardPlanExpiresAt || profile.cardPlanExpiresAt > new Date());
      return {
        plan: premium ? 'PREMIUM' : 'FREE',
        billingEmail: profile.email,
        periodEnd: profile.cardPlanExpiresAt,
        cancelAtPeriodEnd: profile.billingCancelAtPeriodEnd,
        activeCardLimit: premium ? 15 : 3,
        credits: {
          welcome: credits.welcomeRemaining,
          plan: credits.planRemaining,
          purchased: credits.purchasedRemaining,
          granted: credits.planGranted,
          used: credits.planUsed,
          total: credits.welcomeRemaining + credits.planRemaining + credits.purchasedRemaining,
          periodEnd: credits.periodEnd,
        },
      };
    });
  }
  async create(userId: string, dto: BillingOrderDto) {
    const product =
      dto.productId === PREMIUM_MONTHLY.id
        ? PREMIUM_MONTHLY
        : CREDIT_PACKS.find((pack) => pack.id === dto.productId);
    if (!product) throw new BadRequestException('Choose a current product');
    const kind = dto.productId === PREMIUM_MONTHLY.id ? 'PREMIUM' : 'CREDITS';
    if (kind === 'PREMIUM' && !dto.recurringConsent)
      throw new BadRequestException('Review and accept the subscription terms first.');
    if (dto.paymentMethod === 'CARD') {
      if (!dto.cardId) throw new BadRequestException('Choose a card');
      const card = await this.prisma.card.findFirst({
        where: { id: dto.cardId, userId, status: 'ACTIVE', expirationDate: { gt: new Date() } },
      });
      if (!card) throw new NotFoundException('Active card not found');
    } else if (dto.cardId) throw new BadRequestException('Card is not part of this payment method');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "profiles" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      const existing = await tx.billingOrder.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: dto.idempotencyKey } },
      });
      if (existing) {
        if (existing.productId !== dto.productId)
          throw new ConflictException('This purchase identity belongs to another product.');
        if (existing.status === 'SUCCESS' || existing.status === 'PENDING')
          return this.view(existing);
        const retry = await tx.billingOrder.update({
          where: { id: existing.id },
          data: {
            status: 'PENDING',
            paymentMethod: dto.paymentMethod,
            cardId: dto.cardId ?? null,
            failureReason: null,
          },
        });
        return this.view(retry);
      }
      const order = await tx.billingOrder.create({
        data: {
          id: randomUUID(),
          userId,
          idempotencyKey: dto.idempotencyKey,
          kind,
          productId: dto.productId,
          amount: product.amount,
          credits: product.credits,
          paymentMethod: dto.paymentMethod,
          cardId: dto.cardId,
        },
      });
      return this.view(order);
    });
  }
  async get(userId: string, id: string) {
    const order = await this.prisma.billingOrder.findFirst({ where: { id, userId } });
    if (!order) throw new NotFoundException('Purchase not found');
    return this.view(order);
  }
  async confirm(userId: string, id: string, code: string) {
    await this.passcode.validate(userId, code);
    const settings = this.config.get('profileHub', { infer: true });
    if (!settings.billingEnabled)
      throw new ServiceUnavailableException(
        'Payments are temporarily unavailable. No charge was made.',
      );
    return this.settle(userId, id);
  }
  private async settle(userId: string, id: string, renewalDue?: Date) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "profiles" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      const order = await tx.billingOrder.findFirst({ where: { id, userId } });
      if (!order) throw new NotFoundException('Purchase not found');
      if (order.status === 'SUCCESS') return this.view(order);
      if (order.status !== 'PENDING')
        throw new ConflictException('Retry the confirmed failed purchase before paying again.');
      if (order.paymentMethod !== 'WALLET')
        throw new ServiceUnavailableException(
          'Card payment processing is not configured. No charge was made.',
        );
      const profile = await tx.profile.findUniqueOrThrow({ where: { id: userId } });
      if (
        renewalDue &&
        (profile.billingCancelAtPeriodEnd ||
          profile.cardPlanExpiresAt?.getTime() !== renewalDue.getTime())
      ) {
        return this.view(
          await tx.billingOrder.update({ where: { id }, data: { status: 'CANCELLED' } }),
        );
      }
      if (
        order.kind === 'PREMIUM' &&
        !renewalDue &&
        profile.cardPlan === 'PREMIUM' &&
        (!profile.cardPlanExpiresAt || profile.cardPlanExpiresAt > new Date())
      ) {
        throw new ConflictException('Premium is already active for this billing period.');
      }
      const wallet = await tx.wallet.findFirst({ where: { account: { userId }, isActive: true } });
      if (!wallet) throw new NotFoundException('Wallet not found');
      if (wallet.currency !== order.currency)
        throw new BadRequestException('Wallet currency does not match this purchase.');
      const debit = await tx.wallet.updateMany({
        where: { id: wallet.id, balance: { gte: order.amount } },
        data: { balance: { decrement: order.amount } },
      });
      if (debit.count !== 1) {
        if (renewalDue)
          await tx.profile.update({
            where: { id: userId },
            data: { billingCancelAtPeriodEnd: true },
          });
        return this.view(
          await tx.billingOrder.update({
            where: { id },
            data: {
              status: 'FAIL',
              failureReason:
                'Insufficient wallet balance. No credits or Premium allowance were added.',
            },
          }),
        );
      }
      await tx.aiCreditAccount.upsert({ where: { userId }, create: { userId }, update: {} });
      const periodStart = new Date();
      const periodEnd = new Date(periodStart);
      // Calendar-month renewal, clamped at month end (e.g. Jan 31 -> Feb 28).
      const day = periodEnd.getUTCDate();
      periodEnd.setUTCDate(1);
      periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
      periodEnd.setUTCDate(
        Math.min(
          day,
          new Date(
            Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() + 1, 0),
          ).getUTCDate(),
        ),
      );
      if (order.kind === 'PREMIUM') {
        await tx.profile.update({
          where: { id: userId },
          data: {
            cardPlan: 'PREMIUM',
            cardPlanExpiresAt: periodEnd,
            billingCancelAtPeriodEnd: false,
          },
        });
        await tx.aiCreditAccount.update({
          where: { userId },
          data: {
            planRemaining: order.credits,
            planGranted: order.credits,
            planUsed: 0,
            periodEnd,
          },
        });
      } else {
        await tx.aiCreditAccount.update({
          where: { userId },
          data: { purchasedRemaining: { increment: order.credits } },
        });
      }
      const transactionId = randomUUID();
      await tx.transaction.create({
        data: {
          id: transactionId,
          userId,
          walletId: wallet.id,
          type: 'PAYMENT',
          status: 'SUCCESS',
          approvalStatus: 'APPROVED',
          approvedAt: periodStart,
          amount: order.amount,
          currency: order.currency,
          description: order.kind === 'PREMIUM' ? 'BONDE Premium' : 'AI Credits',
          metadata: {
            transactionType:
              order.kind === 'PREMIUM'
                ? renewalDue
                  ? 'SUBSCRIPTION_RENEWAL'
                  : 'PREMIUM_SUBSCRIPTION'
                : 'AI_CREDIT_PURCHASE',
            serviceProvider: 'BONDE',
            merchant: 'BONDE',
            package:
              order.productId === PREMIUM_MONTHLY.id
                ? PREMIUM_MONTHLY.name
                : (CREDIT_PACKS.find((pack) => pack.id === order.productId)?.name ??
                  order.productId),
            plan: 'Premium',
            billingFrequency: 'Monthly',
            creditsPurchased: String(order.credits),
            packagePrice: order.amount.toFixed(2),
            paymentMethod: 'BONDE Wallet',
            ...(order.kind === 'PREMIUM'
              ? {
                  nextBillingDate: periodEnd.toISOString(),
                  subscriptionStartDate: periodStart.toISOString(),
                }
              : {}),
          },
        },
      });
      await tx.auditLog.create({
        data: {
          id: randomUUID(),
          userId,
          action: renewalDue ? 'billing.subscription.renewal' : 'billing.purchase',
          entityType: 'transaction',
          entityId: transactionId,
          metadata: {
            orderId: order.id,
            productId: order.productId,
            amount: order.amount.toFixed(2),
            credits: order.credits,
          },
        },
      });
      const saved = await tx.billingOrder.update({
        where: { id },
        data: { status: 'SUCCESS', transactionId, failureReason: null },
      });
      return this.view(saved);
    });
  }
  /** Trusted renewal job: only a successfully paid, consented monthly order is a mandate. */
  async renewDue() {
    if (!this.config.get('profileHub', { infer: true }).billingEnabled) return;
    const due = await this.prisma.profile.findMany({
      where: {
        cardPlan: 'PREMIUM',
        cardPlanExpiresAt: { lte: new Date() },
        billingCancelAtPeriodEnd: false,
      },
      select: { id: true, cardPlanExpiresAt: true },
      take: 100,
    });
    for (const profile of due) {
      if (!profile.cardPlanExpiresAt) continue;
      const paid = await this.prisma.billingOrder.findFirst({
        where: { userId: profile.id, kind: 'PREMIUM', status: 'SUCCESS', paymentMethod: 'WALLET' },
        orderBy: { createdAt: 'desc' },
      });
      // Manually granted or legacy Premium never authorizes a wallet debit.
      if (!paid) continue;
      const idempotencyKey = createHash('sha256')
        .update(`renewal:${profile.id}:${profile.cardPlanExpiresAt.toISOString()}`)
        .digest('hex');
      const order = await this.prisma.billingOrder.upsert({
        where: { userId_idempotencyKey: { userId: profile.id, idempotencyKey } },
        create: {
          id: randomUUID(),
          userId: profile.id,
          idempotencyKey,
          kind: 'PREMIUM',
          productId: paid.productId,
          amount: paid.amount,
          credits: paid.credits,
          paymentMethod: 'WALLET',
        },
        update: {},
      });
      if (order.status === 'PENDING')
        await this.settle(profile.id, order.id, profile.cardPlanExpiresAt);
    }
  }
  async cancel(userId: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "profiles" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      await tx.profile.update({ where: { id: userId }, data: { billingCancelAtPeriodEnd: true } });
    });
    return this.summary(userId);
  }
  async cancelOrder(userId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "profiles" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      const order = await tx.billingOrder.findFirst({ where: { id, userId } });
      if (!order) throw new NotFoundException('Purchase not found');
      if (order.status !== 'PENDING') return this.view(order);
      return this.view(
        await tx.billingOrder.update({ where: { id }, data: { status: 'CANCELLED' } }),
      );
    });
  }
  async history(userId: string) {
    const orders = await this.prisma.billingOrder.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return orders.map((order) => this.view(order));
  }
  private view(order: {
    id: string;
    productId: string;
    kind: string;
    amount: Prisma.Decimal;
    currency: string;
    credits: number;
    status: string;
    paymentMethod: string;
    transactionId: string | null;
    failureReason: string | null;
    createdAt: Date;
  }) {
    return {
      ...order,
      amount: order.amount.toFixed(2),
      productName:
        order.productId === PREMIUM_MONTHLY.id
          ? PREMIUM_MONTHLY.name
          : (CREDIT_PACKS.find((pack) => pack.id === order.productId)?.name ?? order.productId),
    };
  }
}
