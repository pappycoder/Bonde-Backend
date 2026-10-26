import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AssistantReplyDto } from './chat-replies.dto.js';

@Injectable()
export class ChatPaymentService {
  constructor(private readonly prisma: PrismaService) {}
  private async proposal(userId: string, chatId: string, messageId: string, itemId: string) {
    if (!(await this.prisma.chat.findFirst({ where: { id: chatId, userId } })))
      throw new NotFoundException('Chat not found');
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, chatId, role: 'ASSISTANT' },
    });
    let item: AssistantReplyDto['items'][number] | undefined;
    try {
      const envelope = JSON.parse(message?.content ?? '{}') as AssistantReplyDto & {
        version: number;
      };
      if (envelope.version === 1 && Array.isArray(envelope.items))
        item = envelope.items.find((entry) => entry.id === itemId);
    } catch {
      /* Invalid stored content is not an actionable proposal. */
    }
    if (!item?.approvalId) throw new NotFoundException('Purchase request not found');
    const approval = await this.prisma.transactionApproval.findFirst({
      where: { id: item.approvalId, transaction: { userId, chatId } },
      include: { transaction: true },
    });
    if (!approval) throw new NotFoundException('Purchase approval not found');
    if (item.decision !== 'APPROVED' || approval.status !== 'APPROVED')
      throw new BadRequestException('Approve this purchase first');
    const transaction = approval.transaction;
    if (
      !transaction.amount.equals(item.amount) ||
      transaction.currency !== item.currency ||
      (item.authorizedLimit && transaction.amount.gt(item.authorizedLimit))
    )
      throw new ConflictException('The purchase quote has changed');
    if (transaction.type !== 'PAYMENT')
      throw new BadRequestException('This request is not a purchase');
    return { item, transaction };
  }

  async instructions(userId: string, chatId: string, messageId: string, itemId: string) {
    const { item, transaction } = await this.proposal(userId, chatId, messageId, itemId);
    return {
      transactionId: transaction.id,
      amount: transaction.amount.toFixed(2),
      currency: transaction.currency,
      merchant: item.merchant ?? transaction.description ?? 'Merchant',
      method: 'MERCHANT_CHECKOUT',
      instructions:
        'Use your funded virtual card at the merchant checkout. Purchases appear in your activity after the card provider confirms them.',
    };
  }
}
