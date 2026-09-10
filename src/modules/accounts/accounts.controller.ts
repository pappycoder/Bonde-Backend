import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { AuditLogService } from '../audit/audit-log.service.js';
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
    private readonly audit: AuditLogService,
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
    await this.audit.record({
      userId: principal.userId,
      action: 'account.create',
      entityType: 'account',
      entityId: account.id,
      metadata: { accountType: account.accountType },
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
    await this.audit.record({
      userId: principal.userId,
      action: 'account.update',
      entityType: 'account',
      entityId: account.id,
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
    await this.audit.record({
      userId: principal.userId,
      action: 'account.delete',
      entityType: 'account',
      entityId: result.id,
    });
    return result;
  }
}
