import { ChatCheckoutService } from './chat-checkout.service.js';
import { ChatCheckoutDto, StartChatCheckoutDto } from './chat-checkout.dto.js';
import { ChatRepliesService } from './chat-replies.service.js';
import {
  RespondToMessageDto,
  ChatItemDecisionDto,
  ChatDecisionResponseDto,
} from './chat-replies.dto.js';
import { StrictThrottle } from '../../common/throttling/strict-throttle.decorator.js';
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
  ChatDto,
  ChatsDeleteResponseDto,
  CreateChatDto,
  CreateMessageDto,
  ListChatsQueryDto,
  ListMessagesQueryDto,
  MessageDto,
  PagedChatsDto,
  PagedMessagesDto,
  UpdateChatDto,
} from './chats.dto.js';
import { ChatsService } from './chats.service.js';

/**
 * Self-service chat history + messages. Users manage their own sessions and
 * append USER-role messages; assistant replies are produced elsewhere.
 */
@ApiTags('chats')
@ApiBearerAuth('access-token')
@Controller('chats')
export class ChatsController {
  constructor(
    private readonly chats: ChatsService,
    private readonly audit: AuditLogService,
    private readonly replies: ChatRepliesService,
    private readonly checkout: ChatCheckoutService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List your chat history (paged, free-text `q`)' })
  @ApiOkResponse({ type: PagedChatsDto })
  @ApiErrorResponse()
  list(@CurrentUser() principal: AuthPrincipal, @Query() query: ListChatsQueryDto) {
    return this.chats.list(principal.userId, {
      q: query.q,
      filter: query.filter,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Start a new chat session' })
  @ApiCreatedResponse({ type: ChatDto })
  @ApiErrorResponse()
  async create(@CurrentUser() principal: AuthPrincipal, @Body() dto: CreateChatDto) {
    const chat = await this.chats.create(principal.userId, dto);
    await this.audit.record({
      userId: principal.userId,
      action: 'chat.create',
      entityType: 'chat',
      entityId: chat.id,
    });
    return chat;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of your chats' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ChatDto })
  @ApiErrorResponse()
  get(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.chats.get(principal.userId, id);
  }

  @Get(':id/messages')
  @ApiOperation({
    summary:
      'List the messages in one of your chats (paged, chronological, `filter=`, free-text `q`)',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PagedMessagesDto })
  @ApiErrorResponse()
  listMessages(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: ListMessagesQueryDto,
  ) {
    return this.chats.listMessages(principal.userId, id, {
      q: query.q,
      filter: query.filter,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Append a message to one of your chats (always USER role)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: MessageDto })
  @ApiErrorResponse()
  async createMessage(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CreateMessageDto,
  ) {
    const message = await this.chats.createMessage(principal.userId, id, dto);
    await this.audit.record({
      userId: principal.userId,
      action: 'chat.message.create',
      entityType: 'message',
      entityId: message.id,
      metadata: { chatId: id },
    });
    return message;
  }

  @Post(':id/respond')
  @StrictThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate an assistant reply to an owned user message' })
  @ApiOkResponse({ type: MessageDto })
  @ApiErrorResponse()
  respond(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RespondToMessageDto,
  ) {
    return this.replies.respond(principal.userId, id, dto.messageId);
  }

  @Post(':id/messages/:messageId/items/:itemId/decision')
  @StrictThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve or decline a server-owned chat purchase proposal' })
  @ApiOkResponse({ type: ChatDecisionResponseDto })
  @ApiErrorResponse()
  async decide(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('messageId', new ParseUUIDPipe({ version: '4' })) messageId: string,
    @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string,
    @Body() dto: ChatItemDecisionDto,
  ) {
    const decision = await this.replies.decide(
      principal.userId,
      id,
      messageId,
      itemId,
      dto.decision,
    );
    await this.audit.record({
      userId: principal.userId,
      action: 'chat.item.decision',
      entityType: 'chat',
      entityId: id,
      metadata: { messageId, itemId, decision: dto.decision },
    });
    return decision;
  }

  @Post(':id/messages/:messageId/items/:itemId/checkout')
  @StrictThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start checkout for an approved chat purchase' })
  @ApiOkResponse({ type: ChatCheckoutDto })
  @ApiErrorResponse()
  async startCheckout(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('messageId', new ParseUUIDPipe({ version: '4' })) messageId: string,
    @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string,
    @Body() dto: StartChatCheckoutDto,
  ) {
    const result = await this.checkout.start(principal.userId, id, messageId, itemId, dto);
    await this.audit.record({
      userId: principal.userId,
      action: 'chat.checkout.start',
      entityType: 'chat',
      entityId: id,
      metadata: { messageId, itemId, transactionId: result.transactionId },
    });
    return result;
  }

  @Get(':id/messages/:messageId/items/:itemId/checkout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get confirmed checkout progress' })
  @ApiOkResponse({ type: ChatCheckoutDto })
  @ApiErrorResponse()
  async checkoutStatus(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('messageId', new ParseUUIDPipe({ version: '4' })) messageId: string,
    @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string,
  ) {
    const result = await this.checkout.progress(principal.userId, id, messageId, itemId);
    return result;
  }

  @Post(':id/messages/:messageId/items/:itemId/checkout/cancel')
  @StrictThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request cancellation of a chat checkout' })
  @ApiOkResponse({ type: ChatCheckoutDto })
  @ApiErrorResponse()
  async cancelCheckout(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('messageId', new ParseUUIDPipe({ version: '4' })) messageId: string,
    @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string,
  ) {
    const result = await this.checkout.progress(principal.userId, id, messageId, itemId, true);
    await this.audit.record({
      userId: principal.userId,
      action: 'chat.checkout.cancel',
      entityType: 'chat',
      entityId: id,
      metadata: { messageId, itemId, transactionId: result.transactionId },
    });
    return result;
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rename one of your chats' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ChatDto })
  @ApiErrorResponse()
  async update(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateChatDto,
  ) {
    const chat = await this.chats.update(principal.userId, id, dto);
    await this.audit.record({
      userId: principal.userId,
      action: 'chat.update',
      entityType: 'chat',
      entityId: id,
    });
    return chat;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete one of your chats (and its messages)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ChatsDeleteResponseDto })
  @ApiErrorResponse()
  async remove(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const result = await this.chats.remove(principal.userId, id);
    await this.audit.record({
      userId: principal.userId,
      action: 'chat.delete',
      entityType: 'chat',
      entityId: id,
    });
    return result;
  }
}
