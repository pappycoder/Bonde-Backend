import { ChatAgent, UnconfiguredChatAgent } from './chat-agent.js';
import { ChatRepliesService } from './chat-replies.service.js';
import { Module } from '@nestjs/common';
import { ChatsController } from './chats.controller.js';
import { ChatsService } from './chats.service.js';
import { AuditLogModule } from '../audit/audit-log.module.js';

@Module({
  imports: [AuditLogModule],
  controllers: [ChatsController],
  providers: [
    ChatsService,
    ChatRepliesService,
    { provide: ChatAgent, useClass: UnconfiguredChatAgent },
  ],
  exports: [ChatsService],
})
export class ChatsModule {}
