import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
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
import { CreateWithdrawalDto, DepositAccountDto, WithdrawalResponseDto } from './funding.dto.js';

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
  ) {}

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
