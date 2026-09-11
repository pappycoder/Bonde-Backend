import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { ActivityService } from '../activity/activity.service.js';
import { humanizeLabel } from '../activity/activity-copy.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import {
  AccountDto,
  AccountsDeleteResponseDto,
  CreateAccountDto,
  UpdateAccountDto,
} from './accounts.dto.js';
import { AccountsService } from './accounts.service.js';

/**
 * Self-service account surface. The user holds exactly one account (404 until
 * provisioned); create/update/delete exist so provisioning/money flows can
 * manage it through the API.
 */
@ApiTags('accounts')
@ApiBearerAuth('access-token')
@Controller('account')
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly activity: ActivityService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get your account (404 until provisioned)' })
  @ApiOkResponse({ type: AccountDto })
  @ApiErrorResponse()
  get(@CurrentUser() principal: AuthPrincipal) {
    return this.accounts.get(principal.userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create your account (409 if one already exists)' })
  @ApiCreatedResponse({ type: AccountDto })
  @ApiErrorResponse()
  async create(@CurrentUser() principal: AuthPrincipal, @Body() dto: CreateAccountDto) {
    const account = await this.accounts.create(principal.userId, dto);
    await this.activity.record({
      userId: principal.userId,
      action: 'account.create',
      entityType: 'account',
      entityId: account.id,
      metadata: { accountType: account.accountType },
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Account created',
        content: `Your ${humanizeLabel(account.accountType)} account was opened successfully and is ready for transfers and payments.`,
      },
    });
    return account;
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update your account (type / active status)' })
  @ApiOkResponse({ type: AccountDto })
  @ApiErrorResponse()
  async update(@CurrentUser() principal: AuthPrincipal, @Body() dto: UpdateAccountDto) {
    const account = await this.accounts.update(principal.userId, dto);
    await this.activity.record({
      userId: principal.userId,
      action: 'account.update',
      entityType: 'account',
      entityId: account.id,
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Account updated',
        content: "Your account was updated. If this wasn't you, review your account settings.",
      },
    });
    return account;
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete your account and its wallet (cascade)' })
  @ApiOkResponse({ type: AccountsDeleteResponseDto })
  @ApiErrorResponse()
  async remove(@CurrentUser() principal: AuthPrincipal) {
    const result = await this.accounts.remove(principal.userId);
    await this.activity.record({
      userId: principal.userId,
      action: 'account.delete',
      entityType: 'account',
      entityId: result.id,
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Account deleted',
        content:
          'Your account and its linked wallet were permanently deleted. If you still have funds, contact support.',
      },
    });
    return result;
  }
}
