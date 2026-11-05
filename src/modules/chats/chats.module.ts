import { ShoppingJobsController } from './shopping-jobs.controller.js';
import { ChatTurnsController } from './chat-turns.controller.js';
import { ChatWorker } from './chat-worker.service.js';
import { AiCreditsModule } from '../billing/ai-credits.module.js';
import { ChatTurnsService } from './chat-turns.service.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit/audit-log.module.js';
import { ShoppingAgent } from './shopping-agent.js';
import { ShoppingSearch } from './shopping-search.service.js';
import { ChatAgent } from './chat-agent.js';
import { ChatPaymentService } from './chat-payment.service.js';
import { ChatRepliesService } from './chat-replies.service.js';
import { ChatsController } from './chats.controller.js';
import { ChatsService } from './chats.service.js';

@Module({
  imports: [AuditLogModule, ProfilesModule, AiCreditsModule],
  controllers: [ChatsController, ChatTurnsController, ShoppingJobsController],
  providers: [
    ChatWorker,
    ShoppingAgent,
    ShoppingSearch,
    ChatTurnsService,
    ChatsService,
    ChatPaymentService,
    ChatRepliesService,
    { provide: ChatAgent, useExisting: ShoppingAgent },
  ],
  exports: [ChatsService],
})
export class ChatsModule {}
