import { DeliveryAddressService } from '../profiles/delivery-address.service.js';
import type { DeliveryAddressInputDto } from '../profiles/delivery-address.dto.js';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly addresses: DeliveryAddressService,
  ) {}
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
    const requiresDelivery =
      item.requiresDelivery ?? (!item.preview || item.preview.mode === 'RETAIL');
    const snapshot = item.deliveryAddress ?? null;
    const delivery = requiresDelivery && !snapshot ? await this.addresses.context(userId) : null;
    return {
      requiresDelivery,
      deliveryAddress: snapshot ?? delivery?.deliveryAddress ?? null,
      recipient: snapshot
        ? { name: snapshot.recipientName, phone: snapshot.recipientPhone }
        : (delivery?.recipient ?? null),
      oneTimeAddress: Boolean(snapshot),
      transactionId: transaction.id,
      amount: transaction.amount.toFixed(2),
      currency: transaction.currency,
      merchant: item.merchant ?? transaction.description ?? 'Merchant',
      method: 'MERCHANT_CHECKOUT',
      instructions:
        'Use your funded virtual card at the merchant checkout. Purchases appear in your activity after the card provider confirms them.',
    };
  }

  /**
   * Attach a one-time delivery address to an approved purchase item without saving
   * it to the buyer's address book. Replaces any previous snapshot for the item.
   */
  async setItemDeliveryAddress(
    userId: string,
    chatId: string,
    messageId: string,
    itemId: string,
    address: DeliveryAddressInputDto,
  ) {
    await this.proposal(userId, chatId, messageId, itemId);
    const {
      recipientName,
      recipientPhone,
      street,
      addressLine2,
      city,
      region,
      lga,
      country,
      postalCode,
    } = address;
    const snapshot = {
      recipientName,
      recipientPhone,
      street,
      addressLine2,
      city,
      region,
      lga,
      country,
      postalCode,
    };
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT "id" FROM "chats" WHERE "id" = ${chatId}::uuid AND "user_id" = ${userId}::uuid FOR UPDATE`;
      if (!owned.length) throw new NotFoundException('Chat not found');
      const message = await tx.message.findFirst({
        where: { id: messageId, chatId, role: 'ASSISTANT' },
      });
      let envelope: (AssistantReplyDto & { version: number }) | null = null;
      try {
        const parsed = JSON.parse(message?.content ?? '{}') as AssistantReplyDto & {
          version: number;
        };
        if (parsed.version === 1 && Array.isArray(parsed.items)) envelope = parsed;
      } catch {
        /* Invalid stored content is not an actionable proposal. */
      }
      const item = envelope?.items.find((entry) => entry.id === itemId);
      if (!message || !envelope || !item) throw new NotFoundException('Purchase request not found');
      item.deliveryAddress = snapshot;
      await tx.message.update({
        where: { id: message.id },
        data: { content: JSON.stringify(envelope) },
      });
      await tx.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
      return snapshot;
    });
  }
}
