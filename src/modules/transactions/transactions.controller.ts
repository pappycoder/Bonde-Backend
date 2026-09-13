import {
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
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { NotificationType } from '@prisma/client';
import { ActivityService } from '../activity/activity.service.js';
import { humanizeLabel } from '../activity/activity-copy.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import {
  CreateTransactionDto,
  ListTransactionsQueryDto,
  PagedTransactionsDto,
  RecentTransactionsQueryDto,
  TransactionDto,
  TransactionsDeleteResponseDto,
  UpdateTransactionDto,
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
  constructor(
    private readonly transactions: TransactionsService,
    private readonly activity: ActivityService,
  ) {}

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

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Record a transaction (owned wallet/card/chat; balance not touched)',
  })
  @ApiCreatedResponse({ type: TransactionDto })
  @ApiErrorResponse()
  async create(@CurrentUser() principal: AuthPrincipal, @Body() dto: CreateTransactionDto) {
    const transaction = await this.transactions.create(principal.userId, dto);
    await this.activity.record({
      userId: principal.userId,
      action: 'transaction.create',
      entityType: 'transaction',
      entityId: transaction.id,
      metadata: { type: transaction.type, amount: transaction.amount },
      notify: {
        type: NotificationType.TRANSACTION,
        title: 'Transaction recorded',
        content: `A ${humanizeLabel(transaction.type)} of ${transaction.amount} ${transaction.currency} was recorded${
          transaction.status === 'PENDING' ? ' and is currently pending' : ''
        }.`,
      },
    });
    return transaction;
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

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update one of your transactions' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TransactionDto })
  @ApiErrorResponse()
  async update(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateTransactionDto,
  ) {
    const transaction = await this.transactions.update(principal.userId, id, dto);
    await this.activity.record({
      userId: principal.userId,
      action: 'transaction.update',
      entityType: 'transaction',
      entityId: id,
      notify: {
        type: NotificationType.TRANSACTION,
        title: 'Transaction updated',
        content: `Your ${humanizeLabel(transaction.type)} transaction was updated — it is now ${humanizeLabel(transaction.status)}.`,
      },
    });
    return transaction;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete one of your transactions' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TransactionsDeleteResponseDto })
  @ApiErrorResponse()
  async remove(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const result = await this.transactions.remove(principal.userId, id);
    await this.activity.record({
      userId: principal.userId,
      action: 'transaction.delete',
      entityType: 'transaction',
      entityId: id,
      notify: {
        type: NotificationType.TRANSACTION,
        title: 'Transaction removed',
        content:
          "A transaction was removed from your history. If you didn't do this, review your account.",
      },
    });
    return result;
  }
}
