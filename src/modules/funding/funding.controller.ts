import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { StrictThrottle } from '../../common/throttling/strict-throttle.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { WalletInsightsService } from './wallet-insights.service.js';

import {
  BankDto,
  CategorizeWalletTransactionDto,
  DeleteBankAccountResponseDto,
  DepositAccountDto,
  ResolveBankAccountDto,
  ResolvedBankAccountDto,
  SavedBankAccountDto,
  UpdateMonthlyBudgetDto,
  WalletBudgetDto,
  WalletCategoryResponseDto,
} from './funding.dto.js';

import { BankAccountsService } from './bank-accounts.service.js';

/** Safe Haven recipient, deposit and budgeting presentation. */
@ApiTags('wallet')
@ApiBearerAuth('access-token')
@Controller('wallet')
export class FundingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly banks: BankAccountsService,
    private readonly insights: WalletInsightsService,
  ) {}

  @Get('budget')
  @ApiOperation({ summary: 'Read your monthly budget and card allocations' })
  @ApiOkResponse({ type: WalletBudgetDto })
  @ApiErrorResponse()
  budget(@CurrentUser() principal: AuthPrincipal) {
    return this.insights.budget(principal.userId);
  }

  @Patch('budget')
  @ApiOperation({ summary: 'Update your monthly wallet budget target' })
  @ApiOkResponse({ type: WalletBudgetDto })
  @ApiErrorResponse()
  async updateBudget(@CurrentUser() principal: AuthPrincipal, @Body() dto: UpdateMonthlyBudgetDto) {
    const budget = await this.insights.updateBudget(principal.userId, dto.monthlyBudget);
    await this.activity.record({
      userId: principal.userId,
      action: 'wallet.budget.update',
      entityType: 'wallet',
      entityId: budget.walletId,
      metadata: { monthlyBudget: dto.monthlyBudget },
    });
    return budget;
  }

  @Patch('transactions/:id/category')
  @ApiOperation({ summary: 'Categorize one of your outgoing wallet transactions' })
  @ApiOkResponse({ type: WalletCategoryResponseDto })
  @ApiErrorResponse()
  categorize(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CategorizeWalletTransactionDto,
  ) {
    return this.insights.categorize(principal.userId, id, dto.category);
  }

  @Get('bank-accounts')
  @ApiOperation({ summary: 'List your saved withdrawal bank accounts' })
  @ApiOkResponse({ type: [SavedBankAccountDto] })
  @ApiErrorResponse()
  savedBankAccounts(@CurrentUser() principal: AuthPrincipal) {
    return this.banks.saved(principal.userId);
  }

  @Post('bank-accounts')
  @StrictThrottle()
  @ApiOperation({ summary: 'Verify and save a withdrawal bank account for your user' })
  @ApiCreatedResponse({ type: SavedBankAccountDto })
  @ApiErrorResponse()
  saveBankAccount(@CurrentUser() principal: AuthPrincipal, @Body() dto: ResolveBankAccountDto) {
    return this.banks.save(principal.userId, dto.bankCode, dto.accountNumber);
  }

  @Delete('bank-accounts/:id')
  @ApiOperation({ summary: 'Remove one of your saved withdrawal bank accounts' })
  @ApiOkResponse({ type: DeleteBankAccountResponseDto })
  @ApiErrorResponse()
  removeBankAccount(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.banks.remove(principal.userId, id);
  }

  @Get('banks')
  @ApiOperation({ summary: 'List supported Nigerian withdrawal banks' })
  @ApiOkResponse({ type: [BankDto] })
  @ApiErrorResponse()
  listBanks() {
    return this.banks.list();
  }

  @Post('resolve-account')
  @StrictThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a Nigerian withdrawal bank account' })
  @ApiOkResponse({ type: ResolvedBankAccountDto })
  @ApiErrorResponse()
  resolveAccount(@Body() dto: ResolveBankAccountDto) {
    return this.banks.resolve(dto.bankCode, dto.accountNumber);
  }

  @Get('deposit-account')
  @ApiOperation({ summary: 'Get your funding virtual account (creates one per user)' })
  @ApiOkResponse({ type: DepositAccountDto })
  @ApiErrorResponse()
  async depositAccount(@CurrentUser() principal: AuthPrincipal) {
    const account = await this.prisma.financeCustomer.findUnique({
      where: { userId: principal.userId },
    });
    if (!account?.bankAccountNumber || account.bankStatus !== 'READY')
      throw new BadRequestException('Complete banking verification to receive deposits');
    return {
      accountNumber: account.bankAccountNumber,
      accountName: account.bankAccountName,
      bankName: 'Safe Haven MFB',
      currency: 'NGN',
      isPermanent: true,
      expiresAt: null,
    };
  }
}
