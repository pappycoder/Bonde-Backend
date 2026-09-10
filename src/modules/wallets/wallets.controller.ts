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
  CreateWalletDto,
  UpdateWalletDto,
  WalletDto,
  WalletsDeleteResponseDto,
} from './wallets.dto.js';
import { WalletsService } from './wallets.service.js';

/**
 * Self-service wallet surface (1:1 with the user's account, 404 until
 * provisioned). Create/update/delete exist so provisioning and money-movement
 * flows can manage it through the API.
 */
@ApiTags('wallets')
@ApiBearerAuth('access-token')
@Controller('wallet')
export class WalletsController {
  constructor(
    private readonly wallets: WalletsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get your wallet (404 until provisioned)' })
  @ApiOkResponse({ type: WalletDto })
  @ApiErrorResponse()
  get(@CurrentUser() principal: AuthPrincipal) {
    return this.wallets.get(principal.userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create your wallet (404 without an account, 409 if one exists)' })
  @ApiCreatedResponse({ type: WalletDto })
  @ApiErrorResponse()
  async create(@CurrentUser() principal: AuthPrincipal, @Body() dto: CreateWalletDto) {
    const wallet = await this.wallets.create(principal.userId, dto);
    await this.audit.record({
      userId: principal.userId,
      action: 'wallet.create',
      entityType: 'wallet',
      entityId: wallet.id,
    });
    return wallet;
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update your wallet (balance / currency / active status)' })
  @ApiOkResponse({ type: WalletDto })
  @ApiErrorResponse()
  async update(@CurrentUser() principal: AuthPrincipal, @Body() dto: UpdateWalletDto) {
    const wallet = await this.wallets.update(principal.userId, dto);
    await this.audit.record({
      userId: principal.userId,
      action: 'wallet.update',
      entityType: 'wallet',
      entityId: wallet.id,
    });
    return wallet;
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete your wallet (400 if it still has transactions)' })
  @ApiOkResponse({ type: WalletsDeleteResponseDto })
  @ApiErrorResponse()
  async remove(@CurrentUser() principal: AuthPrincipal) {
    const result = await this.wallets.remove(principal.userId);
    await this.audit.record({
      userId: principal.userId,
      action: 'wallet.delete',
      entityType: 'wallet',
      entityId: result.id,
    });
    return result;
  }
}
