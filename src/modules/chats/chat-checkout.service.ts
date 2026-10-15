import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { money } from '../../common/money/money.js';
import { ChatCheckoutGateway, type CheckoutProgress } from './chat-checkout.gateway.js';
import { ChatCheckoutDto, StartChatCheckoutDto } from './chat-checkout.dto.js';
import type { AssistantReplyDto } from './chat-replies.dto.js';

type Selection = {
  method: 'ONE_TIME' | 'EXISTING';
  cardId?: string;
  messageId: string;
  itemId: string;
  status?: string;
  reference?: string;
  completedAt?: string;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

@Injectable()
export class ChatCheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ChatCheckoutGateway,
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

  async start(
    userId: string,
    chatId: string,
    messageId: string,
    itemId: string,
    dto: StartChatCheckoutDto,
  ) {
    const { item, transaction } = await this.proposal(userId, chatId, messageId, itemId);
    if ((dto.method === 'EXISTING' && !dto.cardId) || (dto.method === 'ONE_TIME' && dto.cardId))
      throw new BadRequestException('Choose a valid payment method');
    if (dto.cardId) {
      const card = await this.prisma.card.findFirst({ where: { id: dto.cardId, userId } });
      if (!card) throw new NotFoundException('Card not found');
      if (card.status !== 'ACTIVE' || (card.expirationDate && card.expirationDate <= new Date()))
        throw new BadRequestException('Choose an active, unexpired card');
      if (card.maxSpendLimit && transaction.amount.gt(card.maxSpendLimit))
        throw new BadRequestException('This purchase exceeds the card spending limit');
    }
    this.gateway.assertConfigured();
    // Persist method selection under a DB lock. A duplicate request checks
    // status rather than issuing another card or resubmitting a charge.
    const claimed = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "transactions" WHERE "id" = ${transaction.id}::uuid AND "user_id" = ${userId}::uuid FOR UPDATE`;
      const current = await tx.transaction.findFirst({ where: { id: transaction.id, userId } });
      if (!current) throw new NotFoundException('Purchase not found');
      if (!current.amount.equals(item.amount) || current.currency !== item.currency)
        throw new ConflictException('The purchase quote has changed');
      const authorization = await tx.transactionApproval.findFirst({
        where: {
          id: item.approvalId,
          status: 'APPROVED',
          transaction: { id: current.id, userId, chatId },
        },
      });
      if (!authorization) throw new ConflictException('The purchase approval has changed');
      const metadata = object(current.metadata);
      const previous = object(metadata.bondeCheckout);
      if (previous.method) {
        if (
          previous.messageId !== messageId ||
          previous.itemId !== itemId ||
          previous.method !== dto.method ||
          (dto.method === 'EXISTING' && previous.cardId !== dto.cardId)
        )
          throw new ConflictException('This purchase already has a payment method');
        return false;
      }
      if (current.status !== 'PENDING')
        throw new ConflictException('This purchase is no longer pending');
      await tx.transaction.update({
        where: { id: current.id },
        data: {
          metadata: {
            ...metadata,
            bondeCheckout: { ...dto, messageId, itemId, status: 'PREPARING' },
          } as Prisma.InputJsonValue,
        },
      });
      return true;
    });
    const result = claimed
      ? await this.gateway.start({
          userId,
          transactionId: transaction.id,
          method: dto.method,
          cardId: dto.cardId,
          amount: money(transaction.amount),
          currency: transaction.currency,
          merchant: item.merchant,
          spendingLimit: item.authorizedLimit ?? money(transaction.amount),
        })
      : await this.gateway.status(transaction.id);
    return this.save(userId, transaction.id, item.merchant, messageId, itemId, result);
  }

  async progress(
    userId: string,
    chatId: string,
    messageId: string,
    itemId: string,
    cancel = false,
  ) {
    const { item, transaction } = await this.proposal(userId, chatId, messageId, itemId);
    const selection = object(object(transaction.metadata).bondeCheckout);
    if (selection.messageId !== messageId || selection.itemId !== itemId)
      throw new NotFoundException('Checkout not found');
    this.gateway.assertConfigured();
    const result = cancel
      ? await this.gateway.cancel(transaction.id)
      : await this.gateway.status(transaction.id);
    return this.save(userId, transaction.id, item.merchant, messageId, itemId, result);
  }

  private async save(
    userId: string,
    transactionId: string,
    merchant: string,
    messageId: string,
    itemId: string,
    progress: CheckoutProgress,
  ): Promise<ChatCheckoutDto> {
    if (!['PREPARING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED'].includes(progress.status))
      throw new BadGatewayException('Checkout returned an invalid status');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "transactions" WHERE "id" = ${transactionId}::uuid AND "user_id" = ${userId}::uuid FOR UPDATE`;
      const transaction = await tx.transaction.findFirst({ where: { id: transactionId, userId } });
      if (!transaction) throw new NotFoundException('Purchase not found');
      const metadata = object(transaction.metadata);
      const selection = object(metadata.bondeCheckout) as Selection;
      if (selection.messageId !== messageId || selection.itemId !== itemId)
        throw new ConflictException('Checkout has changed');
      if (selection.cardId && progress.cardId && selection.cardId !== progress.cardId)
        throw new BadGatewayException('Checkout returned a different card');
      const cardId = selection.cardId ?? progress.cardId;
      const card = cardId ? await tx.card.findFirst({ where: { id: cardId, userId } }) : null;
      if (cardId && !card) throw new BadGatewayException('Checkout returned an invalid card');
      // Only the existing money reconciliation pipeline may mark a payment
      // SUCCESS. Provider text alone cannot produce a paid receipt.
      let status = progress.status;
      if (transaction.status === 'SUCCESS') status = 'SUCCESS';
      else if (status === 'SUCCESS') status = 'PROCESSING';
      if (selection.status === 'CANCELLED' || selection.status === 'FAILED') {
        if (status !== 'SUCCESS') status = selection.status;
      }
      if (status === 'SUCCESS' && (!card || transaction.cardId !== card.id))
        throw new BadGatewayException('Payment card has not been reconciled');
      const reference = selection.reference ?? progress.reference;
      const completedAt =
        selection.completedAt ??
        (status === 'SUCCESS' ? transaction.updatedAt.toISOString() : undefined);
      await tx.transaction.update({
        where: { id: transactionId },
        data: {
          metadata: {
            ...metadata,
            bondeCheckout: {
              ...selection,
              status,
              ...(cardId ? { cardId } : {}),
              ...(reference ? { reference } : {}),
              ...(completedAt ? { completedAt } : {}),
            },
          } as Prisma.InputJsonValue,
        },
      });
      return {
        transactionId,
        status,
        method: selection.method,
        cardId,
        cardLast4: card?.cardNumberLast4,
        oneTimeClosed: selection.method === 'ONE_TIME' && card?.status === 'CANCELLED',
        reference,
        completedAt,
        amount: money(transaction.amount),
        currency: transaction.currency,
        merchant,
      };
    });
  }
}
