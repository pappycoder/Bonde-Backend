import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ServiceOrder, type ServiceQuote } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PasscodeService } from '../passcode/passcode.service.js';
import { LedgerService, type Posting } from './ledger.service.js';
import { fingerprint, holdKey, systemKey, walletKey } from './finance.types.js';
import { object, string } from './shopping-values.js';
import { ServiceQuoteDto } from './service-purchase.dto.js';
import { isTv, serviceIds, serviceOutcome, VtpassClient } from './vtpass.client.js';

type OrderWithQuote = ServiceOrder & { quote: ServiceQuote };

@Injectable()
export class ServicePurchases implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: VtpassClient,
    private readonly ledger: LedgerService,
    private readonly passcode: PasscodeService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.run().catch(() => undefined), 15_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }

  catalog() {
    return serviceIds.map((id) => ({
      id,
      category: isTv(id) ? 'CABLE_TV' : 'DATA',
      autoRenew: false,
    }));
  }
  plans(serviceId: string, signal?: AbortSignal) {
    return this.provider.plans(serviceId, signal);
  }
  verify(serviceId: string, beneficiary: string, signal?: AbortSignal) {
    if (!/^\d{6,20}$/.test(beneficiary))
      throw new BadRequestException('Enter a valid service account or phone number.');
    if (!isTv(serviceId) && !/^(?:0[789]\d{9}|234[789]\d{9})$/.test(beneficiary))
      throw new BadRequestException('Enter a Nigerian mobile number.');
    return this.provider.verify(serviceId, beneficiary, signal);
  }

  async quote(userId: string, input: ServiceQuoteDto, signal?: AbortSignal) {
    const dto = plainToInstance(ServiceQuoteDto, input);
    if (validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).length)
      throw new BadRequestException('Enter a valid plan, beneficiary, and contact phone number.');
    const plan = (await this.plans(dto.serviceId, signal)).find(
      (p) => p.code === dto.variationCode,
    );
    if (!plan) throw new BadRequestException('Choose a current service plan.');
    const verified = await this.verify(dto.serviceId, dto.beneficiary, signal);
    const amount = new Prisma.Decimal(plan.amount);
    const fee = new Prisma.Decimal(this.config.get('shopping', { infer: true }).serviceFee);
    const expiresAt = new Date(Date.now() + 300_000);
    const data = {
      userId,
      serviceId: dto.serviceId,
      variationCode: dto.variationCode,
      name: plan.name,
      beneficiary: dto.beneficiary,
      beneficiaryName: verified.name,
      phone: dto.phone,
      amount,
      fee,
      expiresAt,
    };
    const quote = await this.prisma.serviceQuote.create({
      data: {
        id: randomUUID(),
        ...data,
        fingerprint: fingerprint({
          ...data,
          amount: amount.toFixed(2),
          fee: fee.toFixed(2),
          expiresAt: expiresAt.toISOString(),
        }),
      },
    });
    return this.quoteView(quote);
  }
  quoteView(q: ServiceQuote) {
    return {
      id: q.id,
      serviceId: q.serviceId,
      variationCode: q.variationCode,
      name: q.name,
      beneficiary: q.beneficiary,
      beneficiaryName: q.beneficiaryName,
      phone: q.phone,
      amount: q.amount.toFixed(2),
      fee: q.fee.toFixed(2),
      total: q.amount.add(q.fee).toFixed(2),
      currency: 'NGN',
      expiresAt: q.expiresAt,
      autoRenew: false,
    };
  }
  private async ownedQuote(userId: string, id: string) {
    const quote = await this.prisma.serviceQuote.findFirst({ where: { id, userId } });
    if (!quote) throw new NotFoundException('Quote not found');
    return quote;
  }
  private async revalidate(q: ServiceQuote) {
    if (q.expiresAt <= new Date())
      throw new ConflictException('Quote expired. Request a fresh quote.');
    const plan = (await this.plans(q.serviceId)).find((p) => p.code === q.variationCode);
    if (
      !plan ||
      !q.amount.equals(plan.amount) ||
      !q.fee.equals(this.config.get('shopping', { infer: true }).serviceFee)
    )
      throw new ConflictException('The price has changed. Review a fresh quote.');
    const verified = await this.verify(q.serviceId, q.beneficiary);
    if (verified.name !== q.beneficiaryName)
      throw new ConflictException('Beneficiary details changed. Review a fresh quote.');
  }
  private proofFingerprint(q: ServiceQuote) {
    return fingerprint({
      kind: 'SERVICE_PURCHASE',
      quoteId: q.id,
      quoteFingerprint: q.fingerprint,
    });
  }
  async proof(userId: string, quoteId: string, code: string) {
    const quote = await this.ownedQuote(userId, quoteId);
    await this.revalidate(quote);
    await this.passcode.validate(userId, code);
    const proof = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Math.min(quote.expiresAt.getTime(), Date.now() + 120_000));
    await this.prisma.financeProof.create({
      data: {
        hash: fingerprint(proof),
        userId,
        fingerprint: this.proofFingerprint(quote),
        expiresAt,
      },
    });
    return { proof, expiresAt };
  }
  async execute(userId: string, quoteId: string, proof: string, requestKey: string) {
    this.provider.assertEnabled();
    const prior = await this.prisma.serviceOrder.findUnique({
      where: { userId_requestKey: { userId, requestKey } },
      include: { quote: true },
    });
    if (prior) {
      if (prior.quoteId !== quoteId)
        throw new ConflictException('Request identity belongs to another quote.');
      return this.orderView(prior);
    }
    const quote = await this.ownedQuote(userId, quoteId);
    await this.revalidate(quote);
    if ((await this.observeSupplierBalance()).lt(quote.amount))
      throw new ServiceUnavailableException(
        'Service purchases are temporarily unavailable. No wallet funds were taken.',
      );
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM profiles WHERE id=${userId}::uuid FOR UPDATE`;
      const existing = await tx.serviceOrder.findFirst({
        where: { userId, OR: [{ requestKey }, { quoteId }] },
        include: { quote: true },
      });
      if (existing) {
        if (existing.quoteId !== quoteId)
          throw new ConflictException('Request identity belongs to another quote.');
        return this.orderView(existing);
      }
      const consumed = await tx.financeProof.updateMany({
        where: {
          hash: fingerprint(proof),
          userId,
          fingerprint: this.proofFingerprint(quote),
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (!consumed.count || quote.expiresAt <= new Date())
        throw new UnauthorizedException('Confirm this exact quote with your passcode again.');
      const wallet = await tx.wallet.findFirst({ where: { account: { userId }, isActive: true } });
      if (!wallet) throw new NotFoundException('Wallet not found');
      const id = randomUUID();
      const stamp = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Africa/Lagos',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
        .format(new Date())
        .replace(/\D/g, '');
      const order = await tx.serviceOrder.create({
        data: {
          id,
          userId,
          quoteId,
          requestKey,
          providerReference: `${stamp}${id.replaceAll('-', '')}`,
          environment: this.provider.environment,
        },
      });
      const total = quote.amount.add(quote.fee);
      await this.ledger.post(
        tx,
        `service-hold:${id}`,
        'Service purchase awaiting provider confirmation',
        [
          {
            key: walletKey(userId, 'NGN'),
            userId,
            currency: 'NGN',
            kind: 'WALLET',
            amount: total.negated(),
          },
          { key: holdKey(id, 'NGN'), userId, currency: 'NGN', kind: 'HOLD', amount: total },
        ],
      );
      await tx.transaction.create({
        data: {
          id,
          userId,
          walletId: wallet.id,
          type: 'PAYMENT',
          status: 'PENDING',
          approvalStatus: 'APPROVED',
          approvedAt: new Date(),
          amount: total,
          currency: 'NGN',
          description: quote.name,
          metadata: { live: true, serviceProvider: 'VTPASS', serviceId: quote.serviceId, quoteId },
        },
      });
      await tx.auditLog.create({
        data: {
          id: randomUUID(),
          userId,
          action: 'service.purchase.approved',
          entityType: 'service_order',
          entityId: id,
          metadata: { quoteId, amount: total.toFixed(2) },
        },
      });
      return this.orderView({ ...order, quote });
    });
  }
  async order(userId: string, id: string) {
    const order = await this.prisma.serviceOrder.findFirst({
      where: { id, userId },
      include: { quote: true },
    });
    if (!order) throw new NotFoundException('Service order not found');
    return this.orderView(order);
  }
  private orderView(order: OrderWithQuote) {
    return {
      id: order.id,
      status: order.status,
      quote: this.quoteView(order.quote),
      providerTransactionId: order.providerTransactionId,
      confirmedAt: order.confirmedAt,
      createdAt: order.createdAt,
    };
  }

  async orders(userId: string) {
    return (
      await this.prisma.serviceOrder.findMany({
        where: { userId },
        include: { quote: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })
    ).map((order) => this.orderView(order));
  }
  async orderByQuote(userId: string, quoteId: string) {
    const order = await this.prisma.serviceOrder.findFirst({
      where: { userId, quoteId },
      include: { quote: true },
    });
    if (!order) throw new NotFoundException('Service order not found');
    return this.orderView(order);
  }
  async renewalQuote(userId: string, orderId: string) {
    const order = await this.prisma.serviceOrder.findFirst({
      where: { id: orderId, userId, status: 'SUCCEEDED' },
      include: { quote: true },
    });
    if (!order) throw new NotFoundException('Completed service order not found');
    const q = order.quote;
    return this.quote(userId, {
      serviceId: q.serviceId,
      variationCode: q.variationCode,
      beneficiary: q.beneficiary,
      phone: q.phone,
    });
  }

  async reminder(userId: string, orderId: string, dueAt: Date) {
    if (!Number.isFinite(dueAt.getTime()) || dueAt <= new Date())
      throw new BadRequestException('Choose a future reminder date.');
    const order = await this.prisma.serviceOrder.findFirst({
      where: { id: orderId, userId, status: 'SUCCEEDED' },
    });
    if (!order) throw new NotFoundException('Completed service order not found');
    return this.prisma.serviceReminder.upsert({
      where: { orderId_dueAt: { orderId, dueAt } },
      create: { id: randomUUID(), userId, orderId, dueAt },
      update: {},
    });
  }
  async reminders(userId: string) {
    return this.prisma.serviceReminder.findMany({
      where: { userId },
      orderBy: { dueAt: 'asc' },
      include: { order: { include: { quote: true } } },
    });
  }
  async cancelReminder(userId: string, id: string) {
    const result = await this.prisma.serviceReminder.updateMany({
      where: { id, userId, status: 'SCHEDULED' },
      data: { status: 'CANCELLED' },
    });
    if (!result.count) throw new NotFoundException('Scheduled reminder not found');
    return { cancelled: true };
  }

  async run() {
    if (this.running || !this.config.get('shopping', { infer: true }).vtpassEnabled) return;
    this.running = true;
    try {
      this.provider.assertEnabled();
      // Once claimed for submission, recovery only queries the original reference.
      await this.prisma.serviceOrder.updateMany({
        where: { status: 'PROCESSING', leaseUntil: { lte: new Date() } },
        data: { status: 'PENDING', leaseUntil: null },
      });
      const queued = await this.prisma.serviceOrder.findMany({
        where: { status: 'QUEUED', environment: this.provider.environment },
        include: { quote: true },
        take: 5,
        orderBy: { createdAt: 'asc' },
      });
      for (const order of queued) await this.process(order);
      const pending = await this.prisma.serviceOrder.findMany({
        where: { status: 'PENDING', environment: this.provider.environment },
        include: { quote: true },
        take: 20,
        orderBy: { updatedAt: 'asc' },
      });
      for (const order of pending) {
        try {
          await this.settle(
            order,
            await this.provider.call('/requery', { request_id: order.providerReference }),
          );
        } catch {
          /* Keep the hold until the provider gives a definitive status. */
        }
      }
      await this.sendReminders();
    } finally {
      this.running = false;
    }
  }
  async observeSupplierBalance() {
    const balance = await this.provider.balance();
    await this.prisma.supplierBalanceSnapshot.create({
      data: {
        id: randomUUID(),
        provider: 'VTPASS',
        environment: this.provider.environment,
        balance,
      },
    });
    return balance;
  }

  async requeryReference(reference: string) {
    if (!/^[a-zA-Z0-9]{12,100}$/.test(reference)) return;
    const order = await this.prisma.serviceOrder.findFirst({
      where: {
        providerReference: reference,
        environment: this.provider.environment,
        status: { in: ['PROCESSING', 'PENDING'] },
      },
      include: { quote: true },
    });
    if (order)
      await this.settle(order, await this.provider.call('/requery', { request_id: reference }));
  }

  private async process(order: OrderWithQuote) {
    // Read-only preflight failures are safe to retry: no payment has been submitted.
    let plan;
    try {
      plan = (await this.plans(order.quote.serviceId)).find(
        (p) => p.code === order.quote.variationCode,
      );
    } catch {
      return;
    }
    const claim = await this.prisma.serviceOrder.updateMany({
      where: { id: order.id, status: 'QUEUED' },
      data: {
        status: 'PROCESSING',
        attempts: { increment: 1 },
        leaseUntil: new Date(Date.now() + 60_000),
      },
    });
    if (!claim.count) return;
    try {
      const today = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Africa/Lagos',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .format(new Date())
        .replace(/\D/g, '');
      if (
        !plan ||
        !order.quote.amount.equals(plan.amount) ||
        !order.providerReference.startsWith(today)
      ) {
        // This QUEUED order has never reached the purchase API, so release is safe.
        await this.settle(order, { code: '016' });
        return;
      }
      const response = await this.provider.call('/pay', {
        request_id: order.providerReference,
        serviceID: order.quote.serviceId,
        billersCode: order.quote.beneficiary,
        variation_code: order.quote.variationCode,
        amount: order.quote.amount.toFixed(2),
        phone: order.quote.phone,
        ...(isTv(order.quote.serviceId) ? { subscription_type: 'change', quantity: 1 } : {}),
      });
      await this.settle(order, response);
    } catch {
      await this.prisma.serviceOrder.updateMany({
        where: { id: order.id, status: 'PROCESSING' },
        data: { status: 'PENDING', leaseUntil: null },
      });
    }
  }
  private async settle(order: OrderWithQuote, response: Record<string, unknown>) {
    let outcome = serviceOutcome(response);
    if (outcome === 'SUCCEEDED') {
      const reference = string(response.requestId || response.request_id);
      const amount = String(response.amount ?? '');
      const beneficiary = string(object(object(response.content).transactions).unique_element);
      if (
        reference !== order.providerReference ||
        !/^\d+(\.\d{1,2})?$/.test(amount) ||
        !order.quote.amount.equals(amount) ||
        (beneficiary && beneficiary !== order.quote.beneficiary)
      )
        outcome = 'PENDING';
    }
    if (outcome === 'PENDING') {
      await this.prisma.serviceOrder.updateMany({
        where: { id: order.id, status: { in: ['PROCESSING', 'PENDING'] } },
        data: { status: 'PENDING', leaseUntil: null, updatedAt: new Date() },
      });
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM profiles WHERE id=${order.userId}::uuid FOR UPDATE`;
      const current = await tx.serviceOrder.findUniqueOrThrow({ where: { id: order.id } });
      if (['SUCCEEDED', 'FAILED'].includes(current.status)) return;
      const total = order.quote.amount.add(order.quote.fee);
      const lines: Posting[] = [
        {
          key: holdKey(order.id, 'NGN'),
          userId: order.userId,
          currency: 'NGN',
          kind: 'HOLD',
          amount: total.negated(),
        },
      ];
      if (outcome === 'FAILED')
        lines.push({
          key: walletKey(order.userId, 'NGN'),
          userId: order.userId,
          currency: 'NGN',
          kind: 'WALLET',
          amount: total,
        });
      else {
        lines.push({
          key: systemKey(`vtpass-${order.environment}-settlement`, 'NGN'),
          currency: 'NGN',
          kind: 'SERVICE_SETTLEMENT',
          amount: order.quote.amount,
        });
        if (order.quote.fee.gt(0))
          lines.push({
            key: systemKey('service-fees', 'NGN'),
            currency: 'NGN',
            kind: 'FEES',
            amount: order.quote.fee,
          });
      }
      await this.ledger.post(
        tx,
        `service-settle:${order.id}`,
        outcome === 'SUCCEEDED'
          ? 'Service delivered by provider'
          : 'Failed service purchase funds released',
        lines,
      );
      const providerTransactionId =
        string(object(object(response.content).transactions).transactionId) || null;
      await tx.serviceOrder.update({
        where: { id: order.id },
        data: {
          status: outcome,
          leaseUntil: null,
          providerTransactionId,
          ...(outcome === 'SUCCEEDED' ? { confirmedAt: new Date() } : {}),
        },
      });
      await tx.transaction.update({
        where: { id: order.id },
        data: { status: outcome === 'SUCCEEDED' ? 'SUCCESS' : 'FAIL' },
      });
      await tx.notification.create({
        data: {
          id: randomUUID(),
          userId: order.userId,
          title:
            outcome === 'SUCCEEDED'
              ? 'Subscription purchase successful'
              : 'Subscription purchase failed',
          content:
            outcome === 'SUCCEEDED'
              ? `${order.quote.name} was delivered. Your receipt is available in activity.`
              : 'Your reserved funds have been returned to your wallet.',
          type: 'TRANSACTION',
          metadata: { entityType: 'transaction', entityId: order.id },
        },
      });
      await tx.auditLog.create({
        data: {
          id: randomUUID(),
          userId: order.userId,
          action: 'service.purchase.settled',
          entityType: 'service_order',
          entityId: order.id,
          metadata: { status: outcome, providerTransactionId },
        },
      });
    });
  }
  private async sendReminders() {
    const due = await this.prisma.serviceReminder.findMany({
      where: { status: 'SCHEDULED', dueAt: { lte: new Date() } },
      include: { order: { include: { quote: true } } },
      take: 30,
    });
    for (const reminder of due)
      await this.prisma.$transaction(async (tx) => {
        const claim = await tx.serviceReminder.updateMany({
          where: { id: reminder.id, status: 'SCHEDULED' },
          data: { status: 'SENT' },
        });
        if (!claim.count) return;
        await tx.notification.create({
          data: {
            id: randomUUID(),
            userId: reminder.userId,
            title: 'Subscription renewal reminder',
            content: `Review a current ${reminder.order.quote.name} quote before renewing. No payment has been taken.`,
            type: 'SYSTEM',
            metadata: { entityType: 'service_renewal', entityId: reminder.orderId },
          },
        });
      });
  }
}
