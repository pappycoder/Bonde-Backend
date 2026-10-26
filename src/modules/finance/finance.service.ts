import { FinancePolicy } from './finance-policy.service.js';
import { FinanceRetirement } from './finance-retirement.service.js';
import { FinanceMerchants } from './finance-merchants.service.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PasscodeService } from '../passcode/passcode.service.js';
import { validateRules } from './card-policy.js';
import { FinanceCapabilities } from './finance-capabilities.service.js';
import { FinanceCommandDto } from './finance.dto.js';
import { amountOf, cardKey, currencyOf, fingerprint, holdKey, walletKey } from './finance.types.js';
import { LedgerService, type Posting } from './ledger.service.js';

@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly capabilities: FinanceCapabilities,
    private readonly passcodes: PasscodeService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly policy: FinancePolicy,
    private readonly retirement: FinanceRetirement,
    private readonly merchants: FinanceMerchants,
  ) {}

  async authorizeDisplay(userId: string, cardId: string, passcode: string) {
    this.capabilities.assertEnabled();
    if (!(await this.prisma.card.findFirst({ where: { id: cardId, userId, issuer: 'sudo' } })))
      throw new NotFoundException('Card not found');
    await this.passcodes.validate(userId, passcode);
  }
  async wallets(userId: string) {
    const rows = await this.prisma.financeAccount.findMany({ where: { userId } });
    return ['NGN', 'USD'].map((currency) => ({
      id: walletKey(userId, currency),
      currency,
      balance:
        rows.find((a) => a.key === walletKey(userId, currency))?.balance.toFixed(2) ?? '0.00',
      allocated: rows
        .filter((a) => a.currency === currency && a.kind === 'CARD')
        .reduce((sum, a) => sum.add(a.balance), new Prisma.Decimal(0))
        .toFixed(2),
      held: rows
        .filter((a) => a.currency === currency && a.kind === 'HOLD')
        .reduce((sum, a) => sum.add(a.balance), new Prisma.Decimal(0))
        .toFixed(2),
      isActive: true,
      live: true,
    }));
  }
  async overview(userId: string) {
    return {
      userId,
      capabilities: this.capabilities.view(),
      wallets: await this.wallets(userId),
      customer: this.capabilities.enabled
        ? await this.prisma.financeCustomer.findUnique({
            where: { userId },
            select: {
              userId: true,
              bankAccountId: true,
              bankAccountNumber: true,
              bankAccountName: true,
              bankCode: true,
              status: true,
              bankStatus: true,
              sudoStatus: true,
            },
          })
        : null,
    };
  }
  validate(command: FinanceCommandDto) {
    currencyOf(command.currency);
    amountOf(command.amount, true);
    amountOf(command.fee, true);
    this.capabilities.assertCurrency(command.currency);
    const c = this.config.get('finance');
    const fee =
      command.kind === 'ISSUE'
        ? command.currency === 'NGN'
          ? c.ngnIssueFee
          : c.usdIssueFee
        : command.kind === 'WITHDRAW'
          ? c.withdrawalFee
          : '0.00';
    if (!amountOf(command.fee, true).equals(amountOf(fee, true)))
      throw new ConflictException('Fees changed. Review a new quote.');
    if (['ALLOCATE', 'RETURN', 'WITHDRAW'].includes(command.kind)) amountOf(command.amount);
    else if (command.kind !== 'ISSUE' && !amountOf(command.amount, true).isZero())
      throw new BadRequestException('This action has no amount');
    if (command.kind === 'ISSUE' || command.kind === 'RULES') {
      const { merchantSelections, ...rules } = command.rules ?? {};
      if (rules.merchantIds !== undefined)
        throw new BadRequestException('Use verified merchant selections');
      if (
        merchantSelections !== undefined &&
        (!Array.isArray(merchantSelections) ||
          merchantSelections.length > 20 ||
          merchantSelections.some((value) => typeof value !== 'string'))
      )
        throw new BadRequestException('Invalid merchant selections');
      const rule = validateRules({
        ...rules,
        ...(rules.type === 'MERCHANT'
          ? {
              merchantIds:
                Array.isArray(merchantSelections) && merchantSelections.length ? ['selection'] : [],
            }
          : {}),
      });
      if (rule.type === 'TIME' && Date.parse(rule.end!) <= Date.now())
        throw new BadRequestException('Choose a future expiry');
    }
    if (
      ['RULES', 'MERCHANT_ENROLL', 'MERCHANT_BIND'].includes(command.kind) &&
      !command.rulesVersion
    )
      throw new BadRequestException('Reload this card before changing its settings');
    if (command.kind === 'MERCHANT_ENROLL' && !command.merchantLabel?.trim())
      throw new BadRequestException('Enter the intended merchant');
    if (command.kind === 'MERCHANT_BIND' && (!command.enrollmentId || !command.candidateId))
      throw new BadRequestException('Choose an observed merchant candidate');
    if (
      command.kind === 'THRESHOLDS' &&
      (!command.thresholdType ||
        command.thresholdActive === undefined ||
        command.thresholdValue === undefined)
    )
      throw new BadRequestException('A complete threshold setting is required');
    if (
      [
        'ALLOCATE',
        'RETURN',
        'PAUSE',
        'RESUME',
        'CANCEL',
        'RULES',
        'RETIRE',
        'MERCHANT_ENROLL',
        'MERCHANT_BIND',
      ].includes(command.kind) &&
      !command.cardId
    )
      throw new BadRequestException('Card is required');
    if (['APPROVE', 'DECLINE'].includes(command.kind) && !command.authorizationId)
      throw new BadRequestException('Approval is required');
    if (command.kind === 'CANCEL' && !command.cancellationReason)
      throw new BadRequestException('Select the provider cancellation reason');
    if (
      command.kind === 'WITHDRAW' &&
      (command.currency !== 'NGN' || !command.bankCode || !command.accountNumber)
    )
      throw new BadRequestException('A Nigerian bank recipient is required');
  }
  async proof(userId: string, command: FinanceCommandDto, passcode: string) {
    this.validate(command);
    await this.passcodes.validate(userId, passcode);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 120000);
    await this.prisma.financeProof.create({
      data: { hash: fingerprint(token), userId, fingerprint: fingerprint(command), expiresAt },
    });
    return { proof: token, expiresAt };
  }
  async execute(userId: string, command: FinanceCommandDto, proof: string, key: string) {
    this.validate(command);
    const c = this.config.get('finance');
    if (command.cardId) await this.retirement.ensureDue(userId, command.cardId);
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(key ?? ''))
      throw new BadRequestException('A valid Idempotency-Key is required');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM profiles WHERE id=${userId}::uuid FOR UPDATE`;
      const hash = fingerprint(command);
      const existing = await tx.financeOperation.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
      });
      if (existing) {
        if (existing.fingerprint !== hash)
          throw new ConflictException('Idempotency key belongs to a different request');
        return this.viewOperation(existing);
      }
      const consumed = await tx.financeProof.updateMany({
        where: {
          hash: fingerprint(proof),
          userId,
          fingerprint: hash,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (!consumed.count)
        throw new UnauthorizedException('Confirm this action with your passcode again');
      const account = await tx.account.findUnique({ where: { userId } });
      if (!account?.isActive) throw new BadRequestException('Your financial account is not active');
      const amount = amountOf(command.amount, true),
        fee = amountOf(command.fee, true);
      const operationId = randomUUID();
      let cardId = command.cardId;
      if (command.kind === 'ISSUE') {
        const customer = await tx.financeCustomer.findUnique({ where: { userId } });
        if (customer?.status !== 'READY' || !customer.sudoId)
          throw new BadRequestException('Complete banking and card identity verification first');
        const active = await tx.card.count({
          where: {
            userId,
            issuer: 'sudo',
            status: { not: 'CANCELLED' },
            OR: [
              { retirementStatus: null },
              { retirementStatus: { notIn: ['RETIRED', 'CLOSED'] } },
            ],
          },
        });
        const profile = await tx.profile.findUniqueOrThrow({ where: { id: userId } });
        const premium =
          profile.cardPlan === 'PREMIUM' &&
          (!profile.cardPlanExpiresAt || profile.cardPlanExpiresAt > new Date());
        const rule = await this.merchants.resolveRules(tx, userId, command.rules);
        if (active >= (premium ? 15 : 3))
          throw new BadRequestException('Card plan capacity reached');
        if (!premium) {
          const count = await tx.card.count({
            where: {
              userId,
              issuer: 'sudo',
              status: { not: 'CANCELLED' },
              OR: [
                { retirementStatus: null },
                { retirementStatus: { notIn: ['RETIRED', 'CLOSED'] } },
              ],
              creationLockType: rule.type ? { not: null } : null,
            },
          });
          if (count >= (rule.type ? 2 : 1))
            throw new BadRequestException('Card plan capacity reached');
        }
        const provider = await tx.cardProvider.upsert({
          where: { name: 'Sudo' },
          create: { id: randomUUID(), name: 'Sudo', baseUrl: c.sudoBaseUrl },
          update: {},
        });
        cardId = randomUUID();
        await tx.card.create({
          data: {
            id: cardId,
            userId,
            providerId: provider.id,
            issuer: 'sudo',
            currency: command.currency,
            cardNumberEncrypted: null,
            cardNumberLast4: '0000',
            status: 'PAUSED',
            nickname: command.nickname,
            expirationType: 'yearly',
            expirationDate: new Date(Date.now() + 365 * 86400000),
            creationLockType: rule.type,
            controlExpiresAt: rule.type === 'TIME' ? new Date(rule.end!) : null,
            maxSpendLimit: rule.maxSpendLimit,
            monthlyLimit: rule.monthlyLimit,
            allowTopUp: rule.allowTopUp ?? true,
            notifyHalfSpent: rule.notifyHalfSpent ?? false,
            notifyLowBalance: rule.notifyLowBalance ?? false,
            notifyBudgetReached: rule.notifyBudgetReached ?? false,
          },
        });
        if (rule.type)
          await tx.cardLock.create({
            data: {
              id: randomUUID(),
              cardId,
              lockType: rule.type,
              config: rule as Prisma.InputJsonValue,
            },
          });
      } else if (cardId) {
        const card = await tx.card.findFirst({
          where: { id: cardId, userId, issuer: 'sudo', currency: command.currency },
        });
        if (!card) throw new NotFoundException('Card not found');
        if (card.status === 'CANCELLED') throw new BadRequestException('Card is closed');
        const snapshot = await this.policy.snapshot(tx, card);
        if (
          !snapshot.controlsValid &&
          !['RULES', 'RETURN', 'PAUSE', 'RETIRE', 'CANCEL'].includes(command.kind)
        )
          throw new ConflictException('Card controls require review before this action');
        if ((card.retiredAt || snapshot.reason) && !['RETIRE', 'CANCEL'].includes(command.kind))
          throw new ConflictException('This card is permanently retired');
        if (command.rulesVersion !== undefined && card.rulesVersion !== command.rulesVersion)
          throw new ConflictException('Card settings changed. Reload and review again');
        if (
          command.kind === 'ALLOCATE' &&
          (!card.externalReferenceId || card.expirationDate <= new Date())
        )
          throw new BadRequestException('Card cannot receive a top-up');
        if (command.kind === 'ALLOCATE' && !card.allowTopUp) {
          const previouslyFunded = await tx.financeEntry.count({
            where: { accountKey: cardKey(card.id, command.currency), amount: { gt: 0 } },
          });
          if (previouslyFunded)
            throw new BadRequestException('This card does not allow additional allocations');
        }
        if (command.kind === 'CANCEL') {
          const held = await tx.financeAuthorization.count({ where: { cardId, status: 'HELD' } });
          if (held) throw new ConflictException('Card still has pending purchases');
        }
      }
      const pending = cardId
        ? await tx.financeOperation.findFirst({
            where: { cardId, status: { in: ['QUEUED', 'PROCESSING', 'UNKNOWN'] } },
          })
        : null;
      if (pending) throw new ConflictException('Another action is pending on this card');
      const posting = (accountKey: string, value: Prisma.Decimal, kind: string): Posting => ({
        key: accountKey,
        amount: value,
        currency: command.currency,
        userId,
        kind,
      });
      let status = 'QUEUED';
      if (command.kind === 'RULES') {
        const rule = await this.merchants.resolveRules(tx, userId, command.rules);
        const card = await tx.card.findUniqueOrThrow({ where: { id: cardId! } });
        const snapshot = await this.policy.snapshot(tx, card);
        if ((card.creationLockType ?? undefined) !== rule.type)
          throw new BadRequestException('Create a new card to change its type');
        if (
          !snapshot.controlsValid &&
          ['SELF_DESTRUCT', 'TIME'].includes(card.creationLockType ?? '')
        )
          throw new ConflictException(
            'The original usage or expiry controls cannot be verified. Retire this card and create a replacement',
          );
        if (
          rule.type === 'SELF_DESTRUCT' &&
          ((snapshot.uses >= snapshot.rule.usageLimit! &&
            rule.usageLimit! > snapshot.rule.usageLimit!) ||
            rule.usageLimit! <= snapshot.completedUses ||
            rule.usageLimit! < snapshot.uses)
        )
          throw new ConflictException(
            'Reserved or completed purchases prevent this usage-limit change',
          );
        await tx.financeMerchantEnrollment.updateMany({
          where: { cardId: card.id, status: 'PENDING' },
          data: { status: 'EXPIRED' },
        });
        await tx.cardLock.deleteMany({ where: { cardId: cardId! } });
        if (rule.type)
          await tx.cardLock.create({
            data: {
              id: randomUUID(),
              cardId: cardId!,
              lockType: rule.type,
              config: rule as Prisma.InputJsonValue,
            },
          });
        await tx.card.update({
          where: { id: cardId! },
          data: {
            rulesVersion: { increment: 1 },
            controlExpiresAt: rule.type === 'TIME' ? new Date(rule.end!) : null,
            ...(command.nickname !== undefined ? { nickname: command.nickname } : {}),
            maxSpendLimit: rule.maxSpendLimit ?? null,
            monthlyLimit: rule.monthlyLimit ?? null,
            allowTopUp: rule.allowTopUp ?? true,
            notifyHalfSpent: rule.notifyHalfSpent ?? false,
            notifyLowBalance: rule.notifyLowBalance ?? false,
            notifyBudgetReached: rule.notifyBudgetReached ?? false,
          },
        });
        await tx.cardHistory.create({
          data: {
            id: randomUUID(),
            cardId: cardId!,
            event: 'rules.update',
            changes: rule as Prisma.InputJsonValue,
          },
        });
        status = 'SUCCEEDED';
      }
      if (
        command.kind === 'MERCHANT_ENROLL' ||
        command.kind === 'MERCHANT_BIND' ||
        command.kind === 'RETIRE'
      ) {
        const card = await tx.card.findUniqueOrThrow({ where: { id: cardId! } });
        if (command.kind === 'MERCHANT_ENROLL')
          await this.merchants.start(tx, card, command.merchantLabel!, command.rulesVersion!);
        if (command.kind === 'MERCHANT_BIND')
          await this.merchants.bind(
            tx,
            card,
            command.enrollmentId!,
            command.candidateId!,
            command.rulesVersion!,
          );
        if (command.kind === 'RETIRE')
          await this.retirement.mark(tx, card, card.retirementReason ?? 'USER_REQUESTED', false);
        status = command.kind === 'RETIRE' ? 'QUEUED' : 'SUCCEEDED';
      }
      if (command.kind === 'CANCEL') {
        const card = await tx.card.findUniqueOrThrow({ where: { id: cardId! } });
        await this.retirement.mark(
          tx,
          card,
          card.retirementReason ?? `USER_REPORTED_${command.cancellationReason!.toUpperCase()}`,
          false,
        );
      }
      if (command.kind === 'THRESHOLDS') {
        await tx.transactionThreshold.upsert({
          where: { userId_thresholdType: { userId, thresholdType: command.thresholdType! } },
          create: {
            id: randomUUID(),
            userId,
            thresholdType: command.thresholdType!,
            thresholdValue: command.thresholdValue!,
            isActive: command.thresholdActive!,
          },
          update: { thresholdValue: command.thresholdValue, isActive: command.thresholdActive },
        });
        status = 'SUCCEEDED';
      }
      if (['ISSUE', 'WITHDRAW'].includes(command.kind))
        await this.ledger.post(tx, `reserve:${operationId}`, command.kind, [
          posting(walletKey(userId, command.currency), amount.add(fee).negated(), 'WALLET'),
          posting(holdKey(operationId, command.currency), amount.add(fee), 'HOLD'),
        ]);
      if (command.kind === 'ALLOCATE' || command.kind === 'RETURN') {
        const allocating = command.kind === 'ALLOCATE';
        await this.ledger.post(tx, operationId, command.kind, [
          posting(
            walletKey(userId, command.currency),
            allocating ? amount.negated() : amount,
            'WALLET',
          ),
          posting(
            cardKey(cardId!, command.currency),
            allocating ? amount : amount.negated(),
            'CARD',
          ),
        ]);
        const allocation = await tx.financeAccount.findUniqueOrThrow({
          where: { key: cardKey(cardId!, command.currency) },
        });
        await tx.card.update({ where: { id: cardId }, data: { balance: allocation.balance } });
        status = 'SUCCEEDED';
      }
      if (command.kind === 'APPROVE' || command.kind === 'DECLINE') {
        const authorization = await tx.financeAuthorization.findFirst({
          where: { id: command.authorizationId, userId, currency: command.currency },
        });
        if (!authorization) throw new NotFoundException('Authorization not found');
        const approvalCard = await tx.card.findUniqueOrThrow({
          where: { id: authorization.cardId },
        });
        const approvalPolicy = await this.policy.snapshot(tx, approvalCard);
        if (approvalCard.retiredAt || approvalPolicy.reason)
          throw new ConflictException('This card is permanently retired');
        const changed = await tx.financeAuthorization.updateMany({
          where: {
            id: command.authorizationId,
            userId,
            currency: command.currency,
            status: 'AWAITING_APPROVAL',
          },
          data: {
            status: command.kind === 'APPROVE' ? 'RETRY_APPROVED' : 'DECLINED',
            approvalExpiresAt: new Date(Date.now() + 300000),
          },
        });
        if (!changed.count) throw new NotFoundException('Pending approval not found');
        status = 'SUCCEEDED';
      }
      const operation = await tx.financeOperation.create({
        data: {
          id: operationId,
          userId,
          idempotencyKey: key,
          fingerprint: hash,
          kind: command.kind,
          currency: command.currency,
          amount,
          fee,
          status,
          cardId,
          request: command as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.auditLog.create({
        data: {
          id: randomUUID(),
          userId,
          action: `finance.${command.kind.toLowerCase()}`,
          entityType: 'finance_operation',
          entityId: operationId,
          metadata: { currency: command.currency, amount: command.amount, fee: command.fee },
        },
      });
      if (['ALLOCATE', 'RETURN', 'WITHDRAW'].includes(command.kind)) {
        const wallet = await tx.wallet.findFirstOrThrow({ where: { accountId: account.id } });
        await tx.transaction.create({
          data: {
            id: operationId,
            userId,
            walletId: wallet.id,
            cardId,
            type: command.kind === 'WITHDRAW' ? 'WITHDRAWAL' : 'TRANSFER',
            status: status === 'SUCCEEDED' ? 'SUCCESS' : 'PENDING',
            approvalStatus: 'APPROVED',
            amount,
            currency: command.currency,
            description:
              command.kind === 'WITHDRAW'
                ? 'Bank withdrawal'
                : command.kind === 'RETURN'
                  ? 'Card allocation returned'
                  : command.kind === 'ISSUE'
                    ? 'Card creation'
                    : 'Card allocation',
            metadata: {
              live: true,
              operationId,
              kind: command.kind,
              direction: command.kind === 'RETURN' ? 'CREDIT' : 'DEBIT',
              fee: fee.toFixed(2),
            },
          },
        });
      }
      await tx.notification.create({
        data: {
          id: randomUUID(),
          userId,
          type: cardId ? 'CARD' : 'TRANSACTION',
          title: status === 'SUCCEEDED' ? 'Action completed' : 'Action processing',
          content: `${command.kind.toLowerCase()} · ${amount.toFixed(2)} ${command.currency}`,
          metadata: {
            action: 'finance.operation',
            entityType: 'finance_operation',
            entityId: operationId,
            operationId,
            live: true,
          },
        },
      });
      return this.viewOperation(operation);
    });
  }
  async operations(userId: string) {
    return (
      await this.prisma.financeOperation.findMany({
        where: { userId, kind: { not: 'SWEEP' } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })
    ).map((o) => this.viewOperation(o));
  }
  async operation(userId: string, id: string) {
    const op = await this.prisma.financeOperation.findFirst({
      where: { id, userId, kind: { not: 'SWEEP' } },
    });
    if (!op) throw new NotFoundException('Operation not found');
    return this.viewOperation(op);
  }
  viewOperation(op: {
    id: string;
    kind: string;
    status: string;
    currency: string;
    amount: Prisma.Decimal;
    fee: Prisma.Decimal;
    cardId: string | null;
    createdAt: Date;
    result?: Prisma.JsonValue;
  }) {
    return {
      id: op.id,
      kind: op.kind,
      status: op.status,
      currency: op.currency,
      amount: op.amount.toFixed(2),
      fee:
        op.result &&
        typeof op.result === 'object' &&
        !Array.isArray(op.result) &&
        typeof op.result.customerFee === 'string'
          ? op.result.customerFee
          : op.fee.toFixed(2),
      cardId: op.cardId,
      createdAt: op.createdAt,
    };
  }
}
