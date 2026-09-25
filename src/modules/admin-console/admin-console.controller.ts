import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import {
  AdminListQueryDto,
  AdminUserListQueryDto,
  PagedAdminTransactionsResponseDto,
  PagedAdminUsersResponseDto,
} from './admin-console.dto.js';
import { AdminConsoleTransactionsService } from './admin-console-transactions.service.js';
import { AdminConsoleUsersService } from './admin-console-users.service.js';

/**
 * Dedicated admin read surfaces for profiles/accounts/wallets and the ledger —
 * the tables deliberately excluded from the generic `crud` registry. Read-only
 * for now; suspend + transaction review writes land in Phase 3.
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
  ) {}

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
}
