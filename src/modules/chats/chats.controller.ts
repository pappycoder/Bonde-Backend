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
  ) {}

  @Get()
  @ApiOperation({ summary: 'List your chat history (paged)' })
  @ApiOkResponse({ type: PagedChatsDto })
  @ApiErrorResponse()
  list(@CurrentUser() principal: AuthPrincipal, @Query() query: ListChatsQueryDto) {
    return this.chats.list(principal.userId, { page: query.page, pageSize: query.pageSize });
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
  @ApiOperation({ summary: 'List the messages in one of your chats (paged, chronological)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PagedMessagesDto })
  @ApiErrorResponse()
  listMessages(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: ListMessagesQueryDto,
  ) {
    return this.chats.listMessages(principal.userId, id, {
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
