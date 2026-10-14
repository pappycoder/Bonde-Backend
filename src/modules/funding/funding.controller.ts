import {
  Body,
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { ActivityService } from '../activity/activity.service.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { StrictThrottle } from '../../common/throttling/strict-throttle.decorator.js';
import { VirtualAccountsService } from './virtual-accounts.service.js';
import { WithdrawalsService } from './withdrawals.service.js';
import {
  BankDto,
  SavedBankAccountDto,
  DeleteBankAccountResponseDto,
  ResolveBankAccountDto,
  ResolvedBankAccountDto,
  CreateWithdrawalDto,
  DepositAccountDto,
  WithdrawalResponseDto,
} from './funding.dto.js';

import { BankAccountsService } from './bank-accounts.service.js';

/**
 * Wallet funding surface: read the user's deposit account (a Flutterwave
 * virtual account) and initiate withdrawals from the wallet balance.
 */
@ApiTags('wallet')
@ApiBearerAuth('access-token')
@Controller('wallet')
export class FundingController {
  constructor(
    private readonly virtualAccounts: VirtualAccountsService,
    private readonly withdrawals: WithdrawalsService,
    private readonly activity: ActivityService,
    private readonly banks: BankAccountsService,
  ) {}

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
    const account = await this.virtualAccounts.getDepositAccount(principal.userId);
    await this.activity
      .record({
        userId: principal.userId,
        action: 'wallet.deposit_account',
        entityType: 'virtual_account',
        entityId: account.accountNumber,
      })
      .catch(() => undefined);
    return account;
  }

  @Post('withdrawals')
  @StrictThrottle()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Initiate a withdrawal from your wallet balance' })
  @ApiCreatedResponse({ type: WithdrawalResponseDto })
  @ApiErrorResponse()
  async withdraw(@CurrentUser() principal: AuthPrincipal, @Body() dto: CreateWithdrawalDto) {
    return this.withdrawals.request(principal.userId, dto);
  }
}
