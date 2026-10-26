import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';

import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import {
  ListTransactionsQueryDto,
  PagedTransactionsDto,
  RecentTransactionsQueryDto,
  TransactionDto,
} from './transactions.dto.js';
import { TransactionsService } from './transactions.service.js';

/**
 * Self-service transactions surface: read endpoints plus create/update/delete
 * for the money-movement flows to record activity through the API.
 */
@ApiTags('transactions')
@ApiBearerAuth('access-token')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Get('recent')
  @ApiOperation({ summary: 'List your most recent transactions (bounded)' })
  @ApiOkResponse({ type: [TransactionDto] })
  @ApiErrorResponse()
  recent(@CurrentUser() principal: AuthPrincipal, @Query() query: RecentTransactionsQueryDto) {
    return this.transactions.recent(principal.userId, query.limit);
  }

  @Get()
  @ApiOperation({ summary: 'List all of your transactions (paged, `filter=`, free-text `q`)' })
  @ApiOkResponse({ type: PagedTransactionsDto })
  @ApiErrorResponse()
  list(@CurrentUser() principal: AuthPrincipal, @Query() query: ListTransactionsQueryDto) {
    return this.transactions.list(principal.userId, {
      q: query.q,
      filter: query.filter,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of your transactions' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TransactionDto })
  @ApiErrorResponse()
  get(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.transactions.get(principal.userId, id);
  }
}
