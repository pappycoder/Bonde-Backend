import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';

import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import {
  CardCategoryDto,
  CardDto,
  CardHistoryDto,
  CardLockDto,
  CardMerchantDto,
  ListCardTransactionsQueryDto,
  ListCardsQueryDto,
  PagedCardsDto,
} from './cards.dto.js';
import { CardsService } from './cards.service.js';

import { PagedTransactionsDto } from '../transactions/transactions.dto.js';

/** Owned Sudo card presentation. Writes use passcode-bound finance operations. */
@ApiTags('cards')
@ApiBearerAuth('access-token')
@Controller('cards')
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  @Get()
  @ApiOperation({ summary: 'List your cards (paged, `filter=`, free-text `q`)' })
  @ApiOkResponse({ type: PagedCardsDto })
  @ApiErrorResponse()
  list(@CurrentUser() principal: AuthPrincipal, @Query() query: ListCardsQueryDto) {
    return this.cards.list(principal.userId, {
      q: query.q,
      filter: query.filter,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get('creation-access')
  @ApiOperation({ summary: 'Current plan, retained cards and creation capacity' })
  @ApiErrorResponse()
  creationAccess(@CurrentUser() principal: AuthPrincipal) {
    return this.cards.creationAccess(principal.userId);
  }

  @Get(':id/availability')
  @ApiOperation({ summary: 'Owned-card expiry, usage and current UTC-month budget status' })
  @ApiErrorResponse()
  availability(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.cards.availability(principal.userId, id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of your cards (PAN never returned)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CardDto })
  @ApiErrorResponse()
  get(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.cards.get(principal.userId, id);
  }

  @Get(':id/history')
  @ApiOperation({ summary: 'Read your card change history' })
  @ApiOkResponse({ type: [CardHistoryDto] })
  history(
    @CurrentUser() p: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.cards.listHistory(p.userId, id);
  }

  @Get(':id/transactions')
  @ApiOperation({
    summary: 'List the transactions made with one of your cards (paged, `filter=`, free-text `q`)',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PagedTransactionsDto })
  @ApiErrorResponse()
  listTransactions(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: ListCardTransactionsQueryDto,
  ) {
    return this.cards.listTransactions(principal.userId, id, {
      q: query.q,
      filter: query.filter,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  // -- Merchant allowlist ---------------------------------------------------

  @Get(':id/merchants')
  @ApiOperation({ summary: 'List the merchants a card is restricted to (allowlist)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: [CardMerchantDto] })
  @ApiErrorResponse()
  listMerchants(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.cards.listMerchants(principal.userId, id);
  }

  // -- Locks ----------------------------------------------------------------

  @Get(':id/locks')
  @ApiOperation({ summary: 'List the locks on one of your cards' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: [CardLockDto] })
  @ApiErrorResponse()
  listLocks(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.cards.listLocks(principal.userId, id);
  }

  @Get(':id/locks/:lockId')
  @ApiOperation({ summary: 'Get one of your card locks' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'lockId', format: 'uuid' })
  @ApiOkResponse({ type: CardLockDto })
  @ApiErrorResponse()
  getLock(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('lockId', new ParseUUIDPipe({ version: '4' })) lockId: string,
  ) {
    return this.cards.getLock(principal.userId, id, lockId);
  }

  // -- Restricted categories ------------------------------------------------

  @Get(':id/categories')
  @ApiOperation({ summary: 'List restricted categories on one of your cards' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: [CardCategoryDto] })
  @ApiErrorResponse()
  listCategories(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.cards.listCategories(principal.userId, id);
  }

  @Get(':id/categories/:categoryId')
  @ApiOperation({ summary: 'Get one restricted category on one of your cards' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'categoryId', format: 'uuid' })
  @ApiOkResponse({ type: CardCategoryDto })
  @ApiErrorResponse()
  getCategory(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('categoryId') categoryId: string,
  ) {
    return this.cards.getCategory(principal.userId, id, categoryId);
  }
}
