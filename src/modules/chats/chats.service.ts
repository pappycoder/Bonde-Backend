import { Injectable, NotFoundException } from '@nestjs/common';
import { MessageRole, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';

interface PagedOptions {
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Self-service chat surface. Users own their chats; messages are written by
 * the AI pipeline, and users may append USER-role messages here.
 */
@Injectable()
export class ChatsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, options: PagedOptions = {}) {
    const page = options.page ?? 1;
    const pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const where: Prisma.ChatWhereInput = { userId };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.chat.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.chat.count({ where }),
    ]);

    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  async create(userId: string, dto: { title?: string }) {
    return this.prisma.chat.create({
      data: { id: randomUUID(), userId, title: dto.title ?? null },
    });
  }

  async get(userId: string, chatId: string) {
    const chat = await this.prisma.chat.findFirst({ where: { id: chatId, userId } });
    if (!chat) throw new NotFoundException('Chat not found');
    return chat;
  }

  async update(userId: string, chatId: string, dto: { title?: string }) {
    await this.get(userId, chatId);
    return this.prisma.chat.update({ where: { id: chatId }, data: { title: dto.title } });
  }

  async remove(userId: string, chatId: string) {
    await this.get(userId, chatId);
    await this.prisma.chat.delete({ where: { id: chatId } });
    return { deleted: true as const, id: chatId };
  }

  async listMessages(userId: string, chatId: string, options: PagedOptions = {}) {
    await this.get(userId, chatId);
    const page = options.page ?? 1;
    const pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const where: Prisma.MessageWhereInput = { chatId };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.message.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.message.count({ where }),
    ]);

    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  async createMessage(userId: string, chatId: string, dto: { content: string }) {
    await this.get(userId, chatId);
    return this.prisma.message.create({
      data: {
        id: randomUUID(),
        chatId,
        role: MessageRole.USER,
        content: dto.content,
      },
    });
  }
}
