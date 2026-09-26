import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import {
  AdminListQueryDto,
  AdminStatsResponseDto,
  AdminUserListQueryDto,
  PagedAdminTransactionsResponseDto,
  PagedAdminUsersResponseDto,
  ReviewApprovalBodyDto,
  SuspendUserBodyDto,
} from './admin-console.dto.js';
import { AdminConsoleStatsService } from './admin-console-stats.service.js';
import { AdminConsoleTransactionsService } from './admin-console-transactions.service.js';
import { AdminConsoleUsersService } from './admin-console-users.service.js';

/**
 * Dedicated admin surfaces for profiles/accounts/wallets and the ledger — the
 * tables deliberately excluded from the generic `crud` registry. Phase 2 was
 * read-only; Phase 3 adds the suspend/restore transitions and the transaction
 * review decision.
 *
 * NOTE: route registration order matters. These literal routes are matched
 * BEFORE the generic `CrudController` (`/admin/:resource[/:id]`) — keep this
 * module imported ahead of `CrudModule` in `AppModule`.
 */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin')
export class AdminConsoleController {
  constructor(
    private readonly users: AdminConsoleUsersService,
    private readonly transactions: AdminConsoleTransactionsService,
    private readonly stats: AdminConsoleStatsService,
  ) {}

  @Get('stats')
  @ApiOperation({ summary: 'Dashboard KPIs with monthly and weekly series' })
  @ApiOkResponse({ type: AdminStatsResponseDto })
  @ApiErrorResponse()
  getStats() {
    return this.stats.summary();
  }

  @Get('users/names')
  @ApiOperation({ summary: 'Resolve display names for a CSV-delimited list of user ids' })
  @ApiQuery({
    name: 'ids',
    required: true,
    example: 'a…1,b…2',
    description: 'Comma-separated UUIDs',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'id → fullName',
    },
  })
  @ApiErrorResponse()
  names(@Query('ids') ids?: string): Promise<Record<string, string>> {
    return this.users.names(ids);
  }

  @Get('users')
  @ApiOperation({ summary: 'List admin users (paged, searchable, derived-status filter)' })
  @ApiOkResponse({ type: PagedAdminUsersResponseDto })
  @ApiErrorResponse()
  listUsers(@Query() query: AdminUserListQueryDto) {
    return this.users.list(query);
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'Get one admin user with account, wallet and recent transactions' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({
    schema: { type: 'object' },
    description: 'The admin user with account, wallet and recent transactions',
  })
  @ApiErrorResponse()
  getUser(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.users.get(id);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'List admin transactions (paged, searchable, enum filters)' })
  @ApiOkResponse({ type: PagedAdminTransactionsResponseDto })
  @ApiErrorResponse()
  listTransactions(@Query() query: AdminListQueryDto) {
    return this.transactions.list(query);
  }

  @Get('transactions/:id')
  @ApiOperation({ summary: 'Get one transaction with wallet, card, approvals and provider events' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({
    schema: { type: 'object' },
    description: 'The transaction with wallet, card, approvals and provider events',
  })
  @ApiErrorResponse()
  getTransaction(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.transactions.get(id);
  }

  @Post('users/:id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend a user (deactivates the 1:1 account + wallet)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ schema: { type: 'object' }, description: 'The refreshed admin user' })
  @ApiErrorResponse()
  suspendUser(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: SuspendUserBodyDto,
  ) {
    return this.users.suspend(id, principal.userId, body.reason);
  }

  @Post('users/:id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a suspended user (reactivates the 1:1 account + wallet)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ schema: { type: 'object' }, description: 'The refreshed admin user' })
  @ApiErrorResponse()
  restoreUser(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.users.restore(id, principal.userId);
  }

  @Post('transactions/:id/approval')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record an admin approval/decline on an in-flight transaction' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ schema: { type: 'object' }, description: 'The refreshed transaction detail' })
  @ApiErrorResponse()
  reviewTransaction(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: ReviewApprovalBodyDto,
  ) {
    return this.transactions.review(id, principal.userId, body);
  }
}
