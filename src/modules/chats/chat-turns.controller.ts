import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiProperty,
  ApiOkResponse,
  ApiAcceptedResponse,
} from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { StrictThrottle } from '../../common/throttling/strict-throttle.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ChatRepliesService } from './chat-replies.service.js';
import { ChatTurnsService } from './chat-turns.service.js';

import { MessageDto } from './chats.dto.js';
export class ChatTurnViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) messageId!: string;
  @ApiProperty({ enum: ['RESERVED', 'RUNNING', 'COMPLETED', 'FAILED'] }) status!: string;
  @ApiProperty({ type: String, nullable: true }) failureCode!: string | null;
  @ApiProperty({ type: () => MessageDto, nullable: true }) message!: MessageDto | null;
  @ApiProperty({ type: () => MessageDto, nullable: true }) reply!: MessageDto | null;
}
export class SubmitTurnDto {
  @IsString() @MinLength(1) @MaxLength(4000) content!: string;
  @ApiProperty({ minLength: 16, maxLength: 100 })
  @Matches(/^[a-zA-Z0-9_-]{16,100}$/)
  requestKey!: string;
}
@ApiTags('chats')
@ApiBearerAuth('access-token')
@ApiErrorResponse()
@Controller('chats/:chatId/turns')
export class ChatTurnsController {
  constructor(
    private readonly turns: ChatTurnsService,
    private readonly replies: ChatRepliesService,
    private readonly prisma: PrismaService,
  ) {}
  @ApiAcceptedResponse({ type: ChatTurnViewDto })
  @Post()
  @HttpCode(202)
  @StrictThrottle()
  @ApiOperation({ summary: 'Reserve one credit and submit an idempotent shopping-assistant turn' })
  async submit(
    @CurrentUser() user: AuthPrincipal,
    @Param('chatId', ParseUUIDPipe) chatId: string,
    @Body() dto: SubmitTurnDto,
  ) {
    const { turn, message } = await this.turns.submit(
      user.userId,
      chatId,
      dto.content,
      dto.requestKey,
    );
    if (turn.status !== 'COMPLETED' && turn.status !== 'RUNNING')
      void this.replies.respond(user.userId, chatId, message.id).catch(() => undefined);
    return this.turns.status(user.userId, chatId, turn.id);
  }
  @ApiOkResponse({ type: ChatTurnViewDto })
  @Get('requests/:requestKey')
  @ApiOperation({ summary: 'Recover a turn after a lost submission response' })
  async byRequest(
    @CurrentUser() user: AuthPrincipal,
    @Param('chatId', ParseUUIDPipe) chatId: string,
    @Param('requestKey') requestKey: string,
  ) {
    const turn = await this.prisma.aiChatTurn.findUnique({
      where: { userId_requestKey: { userId: user.userId, requestKey } },
    });
    return this.turns.status(
      user.userId,
      chatId,
      turn?.id ?? '00000000-0000-0000-0000-000000000000',
    );
  }
  @ApiOkResponse({ type: ChatTurnViewDto })
  @Get(':id')
  @ApiOperation({ summary: 'Read the status and saved reply of an owned chat turn' })
  status(
    @CurrentUser() user: AuthPrincipal,
    @Param('chatId', ParseUUIDPipe) chatId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.turns.status(user.userId, chatId, id);
  }
}
