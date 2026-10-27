import type { DeliveryContext } from '../profiles/delivery-address.dto.js';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AssistantReplyDto } from './chat-replies.dto.js';

/** Integrations provide real search/AI results through this server-only port.
 * A reply may reference an existing owner/chat-bound approval; it never
 * executes a purchase or accepts prices/approvals supplied by the mobile app.
 */
export abstract class ChatAgent {
  abstract reply(input: {
    delivery: DeliveryContext;
    userId: string;
    chatId: string;
    messages: Array<{ role: string; content: string }>;
  }): Promise<AssistantReplyDto>;
}
@Injectable()
export class UnconfiguredChatAgent extends ChatAgent {
  async reply(): Promise<AssistantReplyDto> {
    throw new ServiceUnavailableException(
      'Bonde’s assistant is not available yet. Your message has been saved.',
    );
  }
}
