import { ProfilesModule } from '../profiles/profiles.module.js';
import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit/audit-log.module.js';
import { ChatAgent, UnconfiguredChatAgent } from './chat-agent.js';
import { ChatPaymentService } from './chat-payment.service.js';
import { ChatRepliesService } from './chat-replies.service.js';
import { ChatsController } from './chats.controller.js';
import { ChatsService } from './chats.service.js';

@Module({
  imports: [AuditLogModule, ProfilesModule],
  controllers: [ChatsController],
  providers: [
    ChatsService,
    ChatPaymentService,
    ChatRepliesService,
    { provide: ChatAgent, useClass: UnconfiguredChatAgent },
  ],
  exports: [ChatsService],
})
export class ChatsModule {}
