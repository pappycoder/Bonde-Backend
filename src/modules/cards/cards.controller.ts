import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
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
import { NotificationType } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { ActivityService } from '../activity/activity.service.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import {
  CardCategoryDto,
  CardDto,
  CardHistoryDto,
  CardMerchantDto,
  CardsDeleteResponseDto,
  CardLockDto,
  CreateCardCategoryDto,
  CreateCardDto,
  CreateCardLockDto,
  CreateCardMerchantDto,
  ListCardsQueryDto,
  PagedCardsDto,
  UpdateCardCategoryDto,
  UpdateCardDto,
  UpdateCardLimitDto,
  UpdateCardLockDto,
} from './cards.dto.js';
import { CardsService } from './cards.service.js';
import { PagedTransactionsDto } from '../transactions/transactions.dto.js';
import { MAIL_SENDER, type MailSender } from '../../common/mail/mail.types.js';
import { cardRegisteredEmail } from '../../common/mail/templates/card-registered.js';

/**
 * Self-service cards surface: create/patch (the PAN is generated + encrypted
 * and never returned), list/detail, lifecycle management (pause/resume,
 * spending limits), the composable locks, restricted categories, the merchant
 * allowlist, and the per-card change history.
 */
@ApiTags('cards')
@ApiBearerAuth('access-token')
@Controller('cards')
export class CardsController {
  constructor(
    private readonly cards: CardsService,
    private readonly activity: ActivityService,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List your cards (paged)' })
  @ApiOkResponse({ type: PagedCardsDto })
  @ApiErrorResponse()
  list(@CurrentUser() principal: AuthPrincipal, @Query() query: ListCardsQueryDto) {
    return this.cards.list(principal.userId, { page: query.page, pageSize: query.pageSize });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a virtual card (PAN never returned)' })
  @ApiCreatedResponse({ type: CardDto })
  @ApiErrorResponse()
  async create(@CurrentUser() principal: AuthPrincipal, @Body() dto: CreateCardDto) {
    const card = await this.cards.create(principal.userId, dto);
    await this.activity.record({
      userId: principal.userId,
      action: 'card.create',
      entityType: 'card',
      entityId: card.id,
      notify: {
        type: NotificationType.CARD,
        title: 'Card created',
        content: `Your${card.nickname ? ` "${card.nickname}"` : ''} card ending in ${card.cardNumberLast4} was created and is ready to use.`,
      },
    });
    await this.sendCardRegisteredBestEffort(principal, card);
    return card;
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

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update your card (nickname, limits, card type)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CardDto })
  @ApiErrorResponse()
  async update(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCardDto,
  ) {
    const card = await this.cards.update(principal.userId, id, dto);
    await this.activity.record({
      userId: principal.userId,
      action: 'card.update',
      entityType: 'card',
      entityId: id,
      metadata: dto as never,
      notify: {
        type: NotificationType.CARD,
        title: 'Card updated',
        content: `Your card ending in ${card.cardNumberLast4} was updated. Check the card details to confirm the changes.`,
      },
    });
    return card;
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
    await this.activity.record({
      userId: principal.userId,
      action: 'card.pause',
      entityType: 'card',
      entityId: id,
      notify: {
        type: NotificationType.CARD,
        title: 'Card paused',
        content: `Your card ending in ${card.cardNumberLast4} is paused. Payments are blocked until you resume it.`,
      },
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
    await this.activity.record({
      userId: principal.userId,
      action: 'card.resume',
      entityType: 'card',
      entityId: id,
      notify: {
        type: NotificationType.CARD,
        title: 'Card resumed',
        content: `Your card ending in ${card.cardNumberLast4} is active again and can be used for payments.`,
      },
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
    await this.activity.record({
      userId: principal.userId,
      action: 'card.limit',
      entityType: 'card',
      entityId: id,
      metadata: dto as never,
      notify: {
        type: NotificationType.CARD,
        title: 'Card limits updated',
        content: `The spending limits on your card ending in ${card.cardNumberLast4} were changed and now apply to new transactions.`,
      },
    });
    return card;
  }

  // -- History --------------------------------------------------------------

  @Get(':id/history')
  @ApiOperation({ summary: 'Read the change history of one of your cards' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: [CardHistoryDto] })
  @ApiErrorResponse()
  history(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.cards.listHistory(principal.userId, id);
  }

  @Get(':id/transactions')
  @ApiOperation({ summary: 'List the transactions made with one of your cards (paged)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PagedTransactionsDto })
  @ApiErrorResponse()
  listTransactions(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: ListCardsQueryDto,
  ) {
    return this.cards.listTransactions(principal.userId, id, {
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

  @Post(':id/merchants')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Restrict a card to a merchant (409 if already on it)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: CardMerchantDto })
  @ApiErrorResponse()
  async addMerchant(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CreateCardMerchantDto,
  ) {
    const merchant = await this.cards.addMerchant(principal.userId, id, dto);
    await this.activity.record({
      userId: principal.userId,
      action: 'card.merchant.add',
      entityType: 'card',
      entityId: id,
      metadata: { merchantId: merchant.id, merchantName: merchant.merchantName },
    });
    return merchant;
  }

  @Delete(':id/merchants/:merchantId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a merchant from a card’s allowlist' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'merchantId', format: 'uuid' })
  @ApiOkResponse({ type: CardsDeleteResponseDto })
  @ApiErrorResponse()
  async removeMerchant(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string,
  ) {
    const result = await this.cards.removeMerchant(principal.userId, id, merchantId);
    await this.activity.record({
      userId: principal.userId,
      action: 'card.merchant.remove',
      entityType: 'card',
      entityId: id,
      metadata: { merchantId },
    });
    return result;
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
    await this.activity.record({
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
    await this.activity.record({
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
    await this.activity.record({
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
    await this.activity.record({
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
    await this.activity.record({
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
    await this.activity.record({
      userId: principal.userId,
      action: 'card.category.delete',
      entityType: 'card',
      entityId: id,
      metadata: { categoryId },
    });
    return result;
  }

  /**
   * Best-effort "card registered" email: a delivery failure is audited but must
   * never fail the card creation request. No merchants are attached at creation
   * time, so the allowlist section reads "None".
   */
  private async sendCardRegisteredBestEffort(
    principal: AuthPrincipal,
    card: {
      id: string;
      cardNumberLast4: string;
      nickname: string | null;
      maxSpendLimit: string | null;
      monthlyLimit: string | null;
    },
  ): Promise<void> {
    if (!principal.email) return;
    const email = cardRegisteredEmail({
      firstName: principal.email.split('@')[0] ?? '',
      last4: card.cardNumberLast4,
      nickname: card.nickname,
      maxSpendLimit: card.maxSpendLimit,
      monthlyLimit: card.monthlyLimit,
      merchants: [],
    });
    try {
      await this.mail.send({ to: principal.email, subject: email.subject, html: email.html });
    } catch {
      await this.activity
        .record({
          userId: principal.userId,
          action: 'mail.card_registered',
          entityType: 'mail',
          entityId: card.id,
        })
        .catch(() => undefined);
    }
  }
}
