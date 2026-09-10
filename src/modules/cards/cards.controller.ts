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
import { AuditLogService } from '../audit/audit-log.service.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import {
  CardCategoryDto,
  CardDto,
  CardsDeleteResponseDto,
  CardLockDto,
  CreateCardCategoryDto,
  CreateCardLockDto,
  ListCardsQueryDto,
  PagedCardsDto,
  UpdateCardCategoryDto,
  UpdateCardLimitDto,
  UpdateCardLockDto,
} from './cards.dto.js';
import { CardsService } from './cards.service.js';

/**
 * Self-service cards surface: read-only listing/detail (the PAN is never
 * returned), plus lifecycle management — pause/resume, spending limits, and
 * the composable locks and restricted categories.
 */
@ApiTags('cards')
@ApiBearerAuth('access-token')
@Controller('cards')
export class CardsController {
  constructor(
    private readonly cards: CardsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List your cards (paged)' })
  @ApiOkResponse({ type: PagedCardsDto })
  @ApiErrorResponse()
  list(@CurrentUser() principal: AuthPrincipal, @Query() query: ListCardsQueryDto) {
    return this.cards.list(principal.userId, { page: query.page, pageSize: query.pageSize });
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

  @Patch(':id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pause your card (400 if it was cancelled)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CardDto })
  @ApiErrorResponse()
  async pause(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const card = await this.cards.pause(principal.userId, id);
    await this.audit.record({
      userId: principal.userId,
      action: 'card.pause',
      entityType: 'card',
      entityId: id,
    });
    return card;
  }

  @Patch(':id/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume your card (400 if it was cancelled)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CardDto })
  @ApiErrorResponse()
  async resume(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const card = await this.cards.resume(principal.userId, id);
    await this.audit.record({
      userId: principal.userId,
      action: 'card.resume',
      entityType: 'card',
      entityId: id,
    });
    return card;
  }

  @Patch(':id/limit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change your card spending limits (at least one required)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CardDto })
  @ApiErrorResponse()
  async updateLimit(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCardLimitDto,
  ) {
    const card = await this.cards.updateLimit(principal.userId, id, dto);
    await this.audit.record({
      userId: principal.userId,
      action: 'card.limit',
      entityType: 'card',
      entityId: id,
      metadata: dto as never,
    });
    return card;
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

  @Post(':id/locks')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a lock to one of your cards (one per type)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: CardLockDto })
  @ApiErrorResponse()
  async createLock(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CreateCardLockDto,
  ) {
    const lock = await this.cards.createLock(principal.userId, id, dto);
    await this.audit.record({
      userId: principal.userId,
      action: 'card.lock.create',
      entityType: 'card',
      entityId: id,
      metadata: { lockId: lock.id, lockType: lock.lockType },
    });
    return lock;
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

  @Patch(':id/locks/:lockId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a card lock (config / isActive)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'lockId', format: 'uuid' })
  @ApiOkResponse({ type: CardLockDto })
  @ApiErrorResponse()
  async updateLock(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('lockId', new ParseUUIDPipe({ version: '4' })) lockId: string,
    @Body() dto: UpdateCardLockDto,
  ) {
    const lock = await this.cards.updateLock(principal.userId, id, lockId, dto);
    await this.audit.record({
      userId: principal.userId,
      action: 'card.lock.update',
      entityType: 'card',
      entityId: id,
      metadata: { lockId },
    });
    return lock;
  }

  @Delete(':id/locks/:lockId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a lock from one of your cards' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'lockId', format: 'uuid' })
  @ApiOkResponse({ type: CardsDeleteResponseDto })
  @ApiErrorResponse()
  async deleteLock(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('lockId', new ParseUUIDPipe({ version: '4' })) lockId: string,
  ) {
    const result = await this.cards.deleteLock(principal.userId, id, lockId);
    await this.audit.record({
      userId: principal.userId,
      action: 'card.lock.delete',
      entityType: 'card',
      entityId: id,
      metadata: { lockId },
    });
    return result;
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

  @Post(':id/categories')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Configure a restricted category on one of your cards' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: CardCategoryDto })
  @ApiErrorResponse()
  async createCategory(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CreateCardCategoryDto,
  ) {
    const category = await this.cards.createCategory(principal.userId, id, dto);
    await this.audit.record({
      userId: principal.userId,
      action: 'card.category.create',
      entityType: 'card',
      entityId: id,
      metadata: { categoryId: category.id, category: category.category },
    });
    return category;
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
    @Param('categoryId', new ParseUUIDPipe({ version: '4' })) categoryId: string,
  ) {
    return this.cards.getCategory(principal.userId, id, categoryId);
  }

  @Patch(':id/categories/:categoryId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Allow/deny a restricted category (deny by default)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'categoryId', format: 'uuid' })
  @ApiOkResponse({ type: CardCategoryDto })
  @ApiErrorResponse()
  async updateCategory(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('categoryId', new ParseUUIDPipe({ version: '4' })) categoryId: string,
    @Body() dto: UpdateCardCategoryDto,
  ) {
    const category = await this.cards.updateCategory(principal.userId, id, categoryId, dto);
    await this.audit.record({
      userId: principal.userId,
      action: 'card.category.update',
      entityType: 'card',
      entityId: id,
      metadata: { categoryId },
    });
    return category;
  }

  @Delete(':id/categories/:categoryId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a restricted category from one of your cards' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'categoryId', format: 'uuid' })
  @ApiOkResponse({ type: CardsDeleteResponseDto })
  @ApiErrorResponse()
  async deleteCategory(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('categoryId', new ParseUUIDPipe({ version: '4' })) categoryId: string,
  ) {
    const result = await this.cards.deleteCategory(principal.userId, id, categoryId);
    await this.audit.record({
      userId: principal.userId,
      action: 'card.category.delete',
      entityType: 'card',
      entityId: id,
      metadata: { categoryId },
    });
    return result;
  }
}
