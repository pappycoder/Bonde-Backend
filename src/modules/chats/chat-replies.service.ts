import { DeliveryAddressService } from '../profiles/delivery-address.service.js';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApprovalStatus, MessageRole, Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ChatAgent } from './chat-agent.js';
import { AssistantReplyDto } from './chat-replies.dto.js';

type Envelope = AssistantReplyDto & { version: 1; replyTo: string };
@Injectable()
export class ChatRepliesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: ChatAgent,
    private readonly addresses: DeliveryAddressService,
  ) {}

  async respond(userId: string, chatId: string, messageId: string) {
    const chat = await this.prisma.chat.findFirst({ where: { id: chatId, userId } });
    if (!chat) throw new NotFoundException('Chat not found');
    const messages = await this.prisma.message.findMany({
      where: { chatId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const existing = messages.find(
      (message) => this.envelope(message.role, message.content)?.replyTo === messageId,
    );
    if (existing) return existing;
    const target = messages.findIndex(
      (message) => message.id === messageId && message.role === MessageRole.USER,
    );
    if (target < 0) throw new NotFoundException('User message not found');
    const delivery = await this.addresses.context(userId);
    const result = await this.agent.reply({
      delivery,
      userId,
      chatId,
      messages: messages.slice(0, target + 1).map(({ role, content }) => ({ role, content })),
    });
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new BadGatewayException('The AI service returned an invalid response');
    const reply = plainToInstance(AssistantReplyDto, result);
    if ((await validate(reply, { whitelist: true, forbidNonWhitelisted: true })).length)
      throw new BadGatewayException('The AI service returned an invalid response');
    if (!reply.text.trim() && !reply.items.length)
      throw new BadGatewayException('The AI service returned an empty response');
    for (const item of reply.items) {
      if (new Prisma.Decimal(item.amount).lte(0))
        throw new BadGatewayException('The AI service returned an invalid price');
      for (const attributes of [
        item.specifications,
        item.preview?.selection,
        item.preview?.attributes,
      ]) {
        if (
          attributes &&
          (Object.keys(attributes).length > 20 ||
            Object.entries(attributes).some(
              ([key, value]) => key.length > 100 || typeof value !== 'string' || value.length > 500,
            ))
        )
          throw new BadGatewayException('The AI service returned invalid specifications');
      }
      if (item.preview?.recurringAmount && new Prisma.Decimal(item.preview.recurringAmount).lte(0))
        throw new BadGatewayException('The AI service returned an invalid recurring price');
      if (item.preview?.autoRenew && !['SUBSCRIPTION', 'SOFTWARE'].includes(item.preview.mode))
        throw new BadGatewayException('The AI service returned invalid renewal details');
      item.id = randomUUID();
      item.decision = 'PENDING';
    }
    const content = JSON.stringify({
      version: 1,
      replyTo: messageId,
      text: reply.text,
      items: reply.items,
    });
    // Recheck under a row lock so retries/concurrent calls persist one reply.
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT "id" FROM "chats" WHERE "id" = ${chatId}::uuid AND "user_id" = ${userId}::uuid FOR UPDATE`;
      if (!owned.length) throw new NotFoundException('Chat not found');
      const prior = await tx.message.findMany({ where: { chatId, role: MessageRole.ASSISTANT } });
      const duplicate = prior.find(
        (message) => this.envelope(message.role, message.content)?.replyTo === messageId,
      );
      if (duplicate) return duplicate;
      const message = await tx.message.create({
        data: { id: randomUUID(), chatId, role: MessageRole.ASSISTANT, content },
      });
      await tx.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
      return message;
    });
  }

  async decide(
    userId: string,
    chatId: string,
    messageId: string,
    itemId: string,
    decision: 'APPROVED' | 'DECLINED',
  ) {
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT "id" FROM "chats" WHERE "id" = ${chatId}::uuid AND "user_id" = ${userId}::uuid FOR UPDATE`;
      if (!owned.length) throw new NotFoundException('Chat not found');
      const message = await tx.message.findFirst({
        where: { id: messageId, chatId, role: MessageRole.ASSISTANT },
      });
      const envelope = message && this.envelope(message.role, message.content);
      const item = envelope?.items.find((item) => item.id === itemId);
      if (!message || !envelope || !item) throw new NotFoundException('Chat item not found');
      if (item.decision && item.decision !== 'PENDING') {
        if (item.decision !== decision)
          throw new ConflictException('This item already has a decision');
        return { itemId, decision, approvalId: item.approvalId };
      }
      if (decision === 'APPROVED' && !item.approvalId)
        throw new BadRequestException('This item does not have a purchase approval request yet');
      if (item.approvalId) {
        const approval = await tx.transactionApproval.findFirst({
          where: { id: item.approvalId, transaction: { userId, chatId } },
          include: { transaction: true },
        });
        if (!approval) throw new NotFoundException('Purchase approval not found');
        if (
          !approval.transaction.amount.equals(new Prisma.Decimal(item.amount)) ||
          approval.transaction.currency !== item.currency
        )
          throw new ConflictException(
            'The purchase amount has changed. Request an updated option.',
          );
        if (
          item.authorizedLimit &&
          new Prisma.Decimal(item.amount).gt(item.authorizedLimit) &&
          decision === 'APPROVED'
        )
          throw new BadRequestException('This purchase exceeds its authorized limit');
        if (approval.status !== ApprovalStatus.PENDING && approval.status !== decision)
          throw new ConflictException('This purchase already has a decision');
        if (approval.status === ApprovalStatus.PENDING) {
          const updated = await tx.transactionApproval.updateMany({
            where: {
              id: approval.id,
              status: ApprovalStatus.PENDING,
              transaction: { userId, chatId },
            },
            data: { status: decision, approvedBy: userId },
          });
          if (!updated.count)
            throw new ConflictException('The purchase approval has changed. Please refresh.');
        }
      }
      item.decision = decision;
      await tx.message.update({
        where: { id: message.id },
        data: { content: JSON.stringify(envelope) },
      });
      await tx.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
      return { itemId, decision, approvalId: item.approvalId };
    });
  }

  private envelope(role: string, content: string): Envelope | null {
    if (role !== MessageRole.ASSISTANT) return null;
    try {
      const reply = JSON.parse(content) as Envelope;
      return reply.version === 1 && Array.isArray(reply.items) ? reply : null;
    } catch {
      return null;
    }
  }
}
