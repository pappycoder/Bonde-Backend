import {
  ConflictException,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma, type AiChatTurn } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AiCreditsService } from '../billing/ai-credits.service.js';

@Injectable()
export class ChatTurnsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: AiCreditsService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.reap().catch(() => undefined), 30_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async submit(userId: string, chatId: string, content: string, requestKey: string = randomUUID()) {
    return this.prisma.$transaction(async (tx) => {
      await this.credits.lock(tx, userId);
      if (!(await tx.chat.findFirst({ where: { id: chatId, userId } })))
        throw new NotFoundException('Chat not found');
      const existing = await tx.aiChatTurn.findUnique({
        where: { userId_requestKey: { userId, requestKey } },
      });
      if (existing) {
        const message = await tx.message.findUniqueOrThrow({ where: { id: existing.messageId } });
        if (existing.chatId !== chatId || message.content !== content)
          throw new ConflictException('Request identity belongs to another message');
        return { turn: existing, message };
      }
      const id = randomUUID();
      await this.releaseStale(tx, userId);
      const active = await tx.aiChatTurn.findFirst({
        where: { userId, status: { in: ['RESERVED', 'RUNNING'] } },
      });
      if (active)
        throw new ConflictException({
          code: 'AI_TURN_RUNNING',
          message: 'Wait for your current assistant reply to finish.',
        });
      const grantId = await this.credits.reserve(tx, userId, `${id}:1`);
      const message = await tx.message.create({
        data: { id: randomUUID(), chatId, role: 'USER', content },
      });
      const turn = await tx.aiChatTurn.create({
        data: {
          id,
          userId,
          chatId,
          requestKey,
          messageId: message.id,
          grantId,
          attempt: 1,
          leaseUntil: new Date(Date.now() + 120_000),
        },
      });
      return { turn, message };
    });
  }

  async begin(userId: string, chatId: string, messageId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.credits.lock(tx, userId);
      if (!(await tx.chat.findFirst({ where: { id: chatId, userId } })))
        throw new NotFoundException('Chat not found');
      if (!(await tx.message.findFirst({ where: { id: messageId, chatId, role: 'USER' } })))
        throw new NotFoundException('User message not found');
      await this.releaseStale(tx, userId);
      let turn = await tx.aiChatTurn.findUnique({ where: { messageId } });
      if (turn?.status === 'COMPLETED') return turn;
      if (turn?.status === 'RUNNING')
        throw new ConflictException({
          code: 'AI_TURN_RUNNING',
          message: 'Your assistant reply is still being prepared.',
        });
      if (!turn || turn.status === 'FAILED') {
        const active = await tx.aiChatTurn.findFirst({
          where: { userId, status: { in: ['RESERVED', 'RUNNING'] } },
        });
        if (active)
          throw new ConflictException({
            code: 'AI_TURN_RUNNING',
            message: 'Wait for your current assistant reply to finish.',
          });
        const id = turn?.id ?? randomUUID();
        const attempt = (turn?.attempt ?? 0) + 1;
        const grantId = await this.credits.reserve(tx, userId, `${id}:${attempt}`);
        turn = turn
          ? await tx.aiChatTurn.update({
              where: { id },
              data: { grantId, attempt, status: 'RESERVED', failureCode: null },
            })
          : await tx.aiChatTurn.create({
              data: {
                id,
                userId,
                chatId,
                messageId,
                requestKey: `legacy:${messageId}`,
                grantId,
                attempt,
              },
            });
      }
      return tx.aiChatTurn.update({
        where: { id: turn.id },
        data: { status: 'RUNNING', leaseUntil: new Date(Date.now() + 65_000) },
      });
    });
  }

  async complete(
    turn: AiChatTurn,
    content: string,
    chargeable: boolean,
    usage: Prisma.InputJsonValue = {},
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.credits.lock(tx, turn.userId);
      const current = await tx.aiChatTurn.findUniqueOrThrow({ where: { id: turn.id } });
      if (current.status === 'COMPLETED' && current.replyId)
        return tx.message.findUniqueOrThrow({ where: { id: current.replyId } });
      if (
        current.status !== 'RUNNING' ||
        current.attempt !== turn.attempt ||
        !current.leaseUntil ||
        current.leaseUntil <= new Date()
      )
        throw new ConflictException('This assistant attempt has expired. Please retry.');
      if (!(await tx.chat.findFirst({ where: { id: turn.chatId, userId: turn.userId } })))
        throw new NotFoundException('Chat not found');
      const message = await tx.message.create({
        data: { id: randomUUID(), chatId: turn.chatId, role: 'ASSISTANT', content },
      });
      await this.credits.finish(
        tx,
        turn.userId,
        current.grantId!,
        `${turn.id}:${turn.attempt}`,
        chargeable,
      );
      await tx.aiChatTurn.update({
        where: { id: turn.id },
        data: { status: 'COMPLETED', replyId: message.id, leaseUntil: null, usage },
      });
      return message;
    });
  }

  async fail(turn: AiChatTurn, code = 'AI_GENERATION_FAILED', usage?: Prisma.InputJsonValue) {
    await this.prisma.$transaction(async (tx) => {
      await this.credits.lock(tx, turn.userId);
      const current = await tx.aiChatTurn.findUniqueOrThrow({ where: { id: turn.id } });
      if (current.status !== 'RUNNING' || current.attempt !== turn.attempt) return;
      await this.release(tx, current, code);
      if (usage) await tx.aiChatTurn.update({ where: { id: turn.id }, data: { usage } });
    });
  }

  async status(userId: string, chatId: string, id: string) {
    const turn = await this.prisma.aiChatTurn.findFirst({ where: { id, userId, chatId } });
    if (!turn) throw new NotFoundException('Chat turn not found');
    return {
      id: turn.id,
      message: await this.prisma.message.findUnique({ where: { id: turn.messageId } }),
      messageId: turn.messageId,
      status: turn.status,
      failureCode: turn.failureCode,
      reply: turn.replyId
        ? await this.prisma.message.findUnique({ where: { id: turn.replyId } })
        : null,
    };
  }

  private async release(tx: Prisma.TransactionClient, turn: AiChatTurn, code: string) {
    if (turn.grantId)
      await this.credits.finish(tx, turn.userId, turn.grantId, `${turn.id}:${turn.attempt}`, false);
    await tx.aiChatTurn.update({
      where: { id: turn.id },
      data: { status: 'FAILED', failureCode: code, leaseUntil: null },
    });
  }
  private async releaseStale(tx: Prisma.TransactionClient, userId: string) {
    const turns = await tx.aiChatTurn.findMany({
      where: { userId, status: { in: ['RESERVED', 'RUNNING'] }, leaseUntil: { lte: new Date() } },
    });
    for (const turn of turns) await this.release(tx, turn, 'AI_TURN_EXPIRED');
  }
  async reap() {
    const stale = await this.prisma.aiChatTurn.findMany({
      where: { status: { in: ['RESERVED', 'RUNNING'] }, leaseUntil: { lte: new Date() } },
      take: 50,
    });
    for (const userId of new Set(stale.map((t) => t.userId)))
      await this.prisma.$transaction(async (tx) => {
        await this.credits.lock(tx, userId);
        await this.releaseStale(tx, userId);
      });
  }
}
