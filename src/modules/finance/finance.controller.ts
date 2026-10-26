import { FinanceMerchants } from './finance-merchants.service.js';
import { FinanceReconciliation } from './finance-reconciliation.service.js';
import { AuditLogService } from '../audit/audit-log.service.js';
import { MAIL_SENDER, type MailSender } from '../../common/mail/mail.types.js';
import { cardAuthorizationEmail } from '../../common/mail/templates/card-authorization.js';
import { Prisma } from '@prisma/client';
import {
  Body,
  Query,
  Controller,
  Get,
  Header,
  Inject,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiOkResponse,
  ApiCreatedResponse,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { StrictThrottle } from '../../common/throttling/strict-throttle.decorator.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { FinanceCapabilities } from './finance-capabilities.service.js';
import { FinanceService } from './finance.service.js';
import { FinanceIdentityService } from './finance-identity.service.js';
import { FinanceWorker } from './finance-worker.service.js';
import { FinanceEvents } from './finance-events.service.js';
import { FinanceAuthorizations } from './finance-authorizations.service.js';
import { SafeHavenClient, SudoClient, object, string } from './providers.js';
import { secretMatches } from './finance.types.js';
import {
  FinanceBankCompleteDto,
  FinanceBankIdentityDto,
  FinanceCommandDto,
  FinanceExecuteDto,
  FinanceIdentityDto,
  FinanceProofDto,
  FinanceOperationViewDto,
  FinanceProofViewDto,
  FinanceDisplayViewDto,
} from './finance.dto.js';

import {
  ArrayMaxSize,
  ArrayMinSize,
  IsInt,
  Min,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
export class MerchantVersionDto {
  @IsInt() @Min(1) version!: number;
}
export class MerchantQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsString() @MaxLength(100) cursor?: string;
}
export class MerchantCatalogDto {
  @IsOptional() @IsUUID('4') id?: string;
  @IsString() @MaxLength(100) label!: string;
  @IsOptional() @IsString() @MaxLength(200) website?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  authorizationIds!: string[];
}
export class FinanceDisplayDto {
  @Matches(/^\d{4}$/) passcode!: string;
}
export class FinanceBankRecipientDto {
  @IsString() @MaxLength(10) bankCode!: string;
  @Matches(/^\d{10}$/) accountNumber!: string;
}

@ApiTags('finance')
@ApiBearerAuth('access-token')
@ApiErrorResponse()
@Controller('finance')
export class FinanceController {
  constructor(
    private readonly finance: FinanceService,
    private readonly capabilities: FinanceCapabilities,
    private readonly identity: FinanceIdentityService,
    private readonly prisma: PrismaService,
    private readonly worker: FinanceWorker,
    private readonly events: FinanceEvents,
    private readonly safe: SafeHavenClient,
    private readonly sudo: SudoClient,
    private readonly merchants: FinanceMerchants,
  ) {}
  @Get('capabilities')
  @ApiOperation({ summary: 'Live programme availability and confirmed fees' })
  capabilitiesView() {
    return this.capabilities.view();
  }
  @Get('overview')
  @ApiOperation({ summary: 'Live wallets and banking onboarding status' })
  overview(@CurrentUser() p: AuthPrincipal) {
    return this.finance.overview(p.userId);
  }
  @Post('identity/bank/initiate')
  @StrictThrottle()
  initiate(@CurrentUser() p: AuthPrincipal, @Body() dto: FinanceBankIdentityDto) {
    return this.identity.initiate(p.userId, dto);
  }
  @Post('identity/bank/complete')
  @StrictThrottle()
  completeBank(@CurrentUser() p: AuthPrincipal, @Body() dto: FinanceBankCompleteDto) {
    return this.identity.completeBank(p.userId, dto);
  }
  @Post('identity/cardholder')
  @StrictThrottle()
  cardholder(@CurrentUser() p: AuthPrincipal, @Body() dto: FinanceIdentityDto) {
    return this.identity.cardholder(p.userId, dto);
  }
  @Post('quote')
  @HttpCode(200)
  quote(@Body() command: FinanceCommandDto) {
    this.finance.validate(command);
    return {
      command,
      expiresIn: 120,
      total: new Prisma.Decimal(command.amount).add(command.fee).toFixed(2),
    };
  }
  @Post('proof')
  @ApiOperation({ summary: 'Verify your passcode and issue a short-lived command proof' })
  @ApiCreatedResponse({ type: FinanceProofViewDto })
  @StrictThrottle()
  @Header('Cache-Control', 'no-store')
  proof(@CurrentUser() p: AuthPrincipal, @Body() dto: FinanceProofDto) {
    return this.finance.proof(p.userId, dto.command, dto.passcode);
  }
  @Post('operations')
  @ApiOperation({ summary: 'Execute an operation-bound, idempotent financial command' })
  @ApiCreatedResponse({ type: FinanceOperationViewDto })
  @StrictThrottle()
  async execute(
    @CurrentUser() p: AuthPrincipal,
    @Body() dto: FinanceExecuteDto,
    @Headers('idempotency-key') key: string,
  ) {
    const op = await this.finance.execute(p.userId, dto.command, dto.proof, key);
    // Durable operation is committed first. The job endpoint resumes if this request/process is interrupted.
    if (op.status === 'QUEUED') await this.worker.process(op.id);
    return this.finance.operation(p.userId, op.id);
  }
  @Get('operations')
  @ApiOkResponse({ type: [FinanceOperationViewDto] })
  operations(@CurrentUser() p: AuthPrincipal) {
    return this.finance.operations(p.userId);
  }
  @Get('operation-key/:key') async operationKey(
    @CurrentUser() p: AuthPrincipal,
    @Param('key') key: string,
  ) {
    const op = await this.prisma.financeOperation.findUniqueOrThrow({
      where: { userId_idempotencyKey: { userId: p.userId, idempotencyKey: key } },
    });
    return this.finance.viewOperation(op);
  }
  @Get('operations/:id')
  @ApiOkResponse({ type: FinanceOperationViewDto })
  operation(
    @CurrentUser() p: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.finance.operation(p.userId, id);
  }
  @Get('cards') async cards(@CurrentUser() p: AuthPrincipal) {
    const cards = await this.prisma.card.findMany({
      where: { userId: p.userId, issuer: 'sudo' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        nickname: true,
        cardNumberLast4: true,
        currency: true,
        status: true,
        balance: true,
        externalReferenceId: true,
        expirationDate: true,
        allowTopUp: true,
        creationLockType: true,
        rulesVersion: true,
        retiredAt: true,
        retirementReason: true,
        retirementStatus: true,
        controlExpiresAt: true,
        locks: { select: { config: true } },
      },
    });
    return cards.map((card) => ({ ...card, balance: card.balance.toFixed(2) }));
  }
  @Get('activity') async activity(@CurrentUser() p: AuthPrincipal) {
    const rows = await this.prisma.transaction.findMany({
      where: { userId: p.userId, metadata: { path: ['live'], equals: true } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        type: true,
        status: true,
        currency: true,
        amount: true,
        description: true,
        metadata: true,
        createdAt: true,
      },
    });
    return rows.map((row) => ({ ...row, amount: row.amount.toFixed(2) }));
  }
  @Get('merchants') merchantsView(
    @CurrentUser() p: AuthPrincipal,
    @Query() query: MerchantQueryDto,
  ) {
    return this.merchants.list(p.userId, query.q, query.cursor);
  }
  @Get('cards/:id/merchant-enrollment') merchantEnrollment(
    @CurrentUser() p: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.merchants.current(p.userId, id);
  }
  @Get('approvals') approvals(@CurrentUser() p: AuthPrincipal) {
    return this.prisma.financeAuthorization.findMany({
      where: {
        userId: p.userId,
        OR: [
          { status: 'AWAITING_APPROVAL' },
          { status: 'RETRY_APPROVED', approvalExpiresAt: { gt: new Date() } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
  @Get('banks') banks() {
    this.capabilities.assertCurrency('NGN');
    return this.safe.banks().then((data) => {
      if (!Array.isArray(data)) throw new ServiceUnavailableException('Could not load banks');
      return data.map((value) => {
        const bank = object(value);
        return { name: string(bank.name), code: string(bank.bankCode ?? bank.code) };
      });
    });
  }
  @Post('resolve-account')
  @StrictThrottle()
  async resolve(@Body() dto: FinanceBankRecipientDto) {
    this.capabilities.assertCurrency('NGN');
    const data = object(await this.safe.resolve(dto.bankCode, dto.accountNumber));
    return { accountName: string(data.accountName), accountNumber: dto.accountNumber };
  }
  @Post('cards/:id/display-session')
  @ApiCreatedResponse({ type: FinanceDisplayViewDto })
  @StrictThrottle()
  @Header('Cache-Control', 'no-store')
  async display(
    @CurrentUser() p: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: FinanceDisplayDto,
  ) {
    // Verify the passcode and ownership in this request; never return a business API key or PAN/CVV.
    await this.finance.authorizeDisplay(p.userId, id, dto.passcode);
    const card = await this.prisma.card.findFirstOrThrow({
      where: { id, userId: p.userId, issuer: 'sudo' },
    });
    if (!card.externalReferenceId)
      throw new ServiceUnavailableException('Card is still being provisioned');
    const data = object(
      await this.sudo.call(`/cards/${encodeURIComponent(card.externalReferenceId)}/token`),
    );
    return { cardId: card.externalReferenceId, token: string(data.token) };
  }
  @Post('fx/quote') fx() {
    throw new ServiceUnavailableException('USD conversion is awaiting programme validation');
  }
}

@ApiTags('finance-webhooks')
@Controller('finance')
export class FinanceWebhooksController {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly capabilities: FinanceCapabilities,
    private readonly events: FinanceEvents,
    private readonly authorizations: FinanceAuthorizations,
    private readonly prisma: PrismaService,
    private readonly worker: FinanceWorker,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}
  @Post('webhooks/sudo')
  @Public()
  @SkipThrottle()
  @HttpCode(200)
  async sudo(
    @Headers('authorization') authorization: string | undefined,
    @Body() payload: Record<string, unknown>,
  ) {
    this.capabilities.assertEnabled();
    const c = this.config.get('finance');
    if (
      !secretMatches(authorization, c.sudoWebhookToken) ||
      payload.business !== c.sudoBusinessId ||
      !(c.environment === 'sandbox' ? ['sandbox', 'development'] : ['production']).includes(
        String(payload.environment),
      )
    )
      throw new UnauthorizedException('Invalid provider webhook');
    const data = object(object(payload.data).object),
      type = string(payload.type);
    if (type === 'authorization.code') {
      const card = await this.prisma.card.findFirst({
        where: { externalReferenceId: string(object(data.card)._id), issuer: 'sudo' },
        include: { user: { select: { email: true, emailVerified: true } } },
      });
      const code = string(data.code);
      if (!card || !card.user.emailVerified || !/^\d{4,10}$/.test(code))
        throw new UnauthorizedException('Invalid authorization code event');
      const message = cardAuthorizationEmail(code, card.cardNumberLast4);
      await this.mail.send({ to: card.user.email, ...message });
      return { received: true };
    }
    if (type === 'authorization.request') return this.authorizations.authorize(data);
    if (type === 'card.balance') {
      const providerCard = data.card ? object(data.card) : data;
      const card = await this.prisma.card.findFirst({
        where: { externalReferenceId: string(providerCard._id), issuer: 'sudo', status: 'ACTIVE' },
      });
      const balance = card
        ? await this.prisma.financeAccount.findUnique({
            where: { key: `card:${card.id}:${card.currency}` },
          })
        : null;
      return {
        statusCode: 200,
        data: { responseCode: '00', balance: balance?.balance.toNumber() ?? 0 },
      };
    }
    if (
      [
        'transaction.created',
        'transaction.refund',
        'card.updated',
        'card.terminated',
        'authorization.declined',
      ].includes(type)
    )
      return this.events.receive('sudo', type, string(data._id), {
        deliveryId: string(payload._id),
      });
    return { received: true };
  }
  @Post('webhooks/safe-haven')
  @Public()
  @HttpCode(200)
  async safeHaven(
    @Headers('authorization') authorization: string | undefined,
    @Body() payload: Record<string, unknown>,
  ) {
    this.capabilities.assertEnabled();
    // If the banking programme supports a custom callback header, authenticate it.
    // In all cases the inbox worker independently verifies every transfer with Safe Haven.
    if (
      this.config.get('finance').safeHavenWebhookToken &&
      !secretMatches(authorization, this.config.get('finance').safeHavenWebhookToken)
    )
      throw new UnauthorizedException('Invalid provider webhook');
    const data = object(payload.data),
      type = string(payload.eventType ?? payload.type);
    return this.events.receive('safe-haven', type, string(data._id), {
      sessionId: string(data.sessionId),
      status: String(data.status ?? ''),
      reversed: String(data.isReversed === true),
    });
  }
  @Post('jobs')
  @Public()
  @HttpCode(200)
  async jobs(@Headers('authorization') authorization: string | undefined) {
    if (
      !secretMatches(authorization, `Bearer ${this.config.get('finance').jobToken}`) ||
      !this.config.get('finance').jobToken
    )
      throw new UnauthorizedException();
    this.capabilities.assertEnabled();
    return { operations: await this.worker.run(), inbox: await this.events.run() };
  }
}

@ApiTags('admin-finance')
@ApiBearerAuth('access-token')
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/finance')
export class AdminFinanceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: FinanceCapabilities,
    private readonly worker: FinanceWorker,
    private readonly events: FinanceEvents,
    private readonly reconciliation: FinanceReconciliation,
    private readonly audit: AuditLogService,
    private readonly merchants: FinanceMerchants,
  ) {}
  @Get('merchant-catalog') catalog() {
    return this.merchants.catalog();
  }
  @Post('merchant-catalog/review')
  @StrictThrottle()
  reviewMerchant(@CurrentUser() p: AuthPrincipal, @Body() dto: MerchantCatalogDto) {
    return this.merchants.reviewCatalog(p.userId, dto);
  }
  @Post('merchant-catalog/:id/publish')
  @StrictThrottle()
  publishMerchant(
    @CurrentUser() p: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: MerchantVersionDto,
  ) {
    return this.merchants.publish(p.userId, id, false, dto.version);
  }
  @Post('merchant-catalog/:id/revoke')
  @StrictThrottle()
  revokeMerchant(
    @CurrentUser() p: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: MerchantVersionDto,
  ) {
    return this.merchants.publish(p.userId, id, true, dto.version);
  }
  @Get() async overview() {
    const [operations, inbox, accounts, customers, authorizations] = await Promise.all([
      this.prisma.financeOperation.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 100,
        select: {
          id: true,
          userId: true,
          kind: true,
          status: true,
          currency: true,
          amount: true,
          fee: true,
          cardId: true,
          createdAt: true,
          updatedAt: true,
          result: true,
        },
      }),
      this.prisma.financeInbox.findMany({
        where: { status: { not: 'PROCESSED' } },
        orderBy: { createdAt: 'asc' },
        take: 100,
        select: {
          id: true,
          provider: true,
          eventType: true,
          status: true,
          errorCode: true,
          createdAt: true,
        },
      }),
      this.prisma.financeAccount.groupBy({ by: ['currency', 'kind'], _sum: { balance: true } }),
      this.prisma.financeCustomer.findMany({
        where: { OR: [{ bankStatus: 'PROCESSING' }, { sudoStatus: 'PROCESSING' }] },
        take: 100,
        select: { userId: true, bankStatus: true, sudoStatus: true, updatedAt: true },
      }),
      this.prisma.financeAuthorization.findMany({
        where: { status: 'AWAITING_APPROVAL' },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          userId: true,
          cardId: true,
          amount: true,
          currency: true,
          merchantName: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);
    const differences = await this.prisma.$queryRaw<
      Array<{ key: string; difference: Prisma.Decimal }>
    >`
      SELECT a.key,a.balance-COALESCE(SUM(e.amount),0) AS difference FROM finance_accounts a
      LEFT JOIN finance_entries e ON e.account_key=a.key GROUP BY a.key,a.balance HAVING a.balance<>COALESCE(SUM(e.amount),0)`;
    return {
      capabilities: this.capabilities.view(),
      operations,
      inbox,
      accounts,
      customers,
      authorizations: authorizations.map((row) => ({ ...row, amount: row.amount.toFixed(2) })),
      differences,
      retirements: await this.prisma.card.findMany({
        where: { retiredAt: { not: null } },
        select: {
          id: true,
          userId: true,
          retiredAt: true,
          retirementReason: true,
          retirementStatus: true,
          status: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
    };
  }
  @Get('liquidity') liquidity() {
    return this.reconciliation.liquidity();
  }
  @Post('customers/:id/reconcile')
  @StrictThrottle()
  async reconcileCustomer(
    @CurrentUser() p: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const result = await this.reconciliation.customer(id);
    await this.audit.record({
      userId: p.userId,
      action: 'admin.finance.customer.reconcile',
      entityType: 'profile',
      entityId: id,
    });
    return result;
  }
  @Post('inbox/:id/retry')
  @StrictThrottle()
  async retryEvent(
    @CurrentUser() p: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    await this.prisma.financeInbox.update({
      where: { id },
      data: { status: 'RECEIVED', errorCode: null },
    });
    await this.audit.record({
      userId: p.userId,
      action: 'admin.finance.event.retry',
      entityType: 'finance_inbox',
      entityId: id,
    });
    return { queued: true };
  }
  @Post('reconcile')
  @StrictThrottle()
  async reconcile(@CurrentUser() p: AuthPrincipal) {
    await this.audit.record({
      userId: p.userId,
      action: 'admin.finance.reconcile',
      entityType: 'profile',
      entityId: p.userId,
    });
    return { operations: await this.worker.run(), inbox: await this.events.run() };
  }
}
