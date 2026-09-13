import { Injectable, NotFoundException } from '@nestjs/common';
import { MessageRole, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { parsePaging, toPageResult } from '../../common/paging/paging.js';
import {
  buildFilterWhere,
  type FilterFieldSpec,
  parseFilterEntries,
} from '../../common/paging/filter.js';
import { qWhere } from '../../common/paging/search.js';
import { PrismaService } from '../../prisma/prisma.service.js';

interface PagedOptions {
  page?: number;
  pageSize?: number;
  q?: string;
  filter?: string | string[];
}

const CHAT_FILTER_FIELDS: Record<string, FilterFieldSpec> = {};

const MESSAGE_FILTER_FIELDS: Record<string, FilterFieldSpec> = {
  role: { kind: 'enum' },
};

/**
 * Self-service chat surface. Users own their chats; messages are written by
 * the AI pipeline, and users may append USER-role messages here.
 */
@Injectable()
export class ChatsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, options: PagedOptions = {}) {
    const { page, pageSize, skip, take } = parsePaging(options.page, options.pageSize);
    const where = {
      userId,
      ...buildFilterWhere(parseFilterEntries(options.filter), CHAT_FILTER_FIELDS),
      ...qWhere(options.q, ['title']),
    } as Prisma.ChatWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.chat.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.chat.count({ where }),
    ]);

    return toPageResult(items, total, page, pageSize);
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
    const { page, pageSize, skip, take } = parsePaging(options.page, options.pageSize);
    const where = {
      chatId,
      ...buildFilterWhere(parseFilterEntries(options.filter), MESSAGE_FILTER_FIELDS),
      ...qWhere(options.q, ['content']),
    } as Prisma.MessageWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.message.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.message.count({ where }),
    ]);

    return toPageResult(items, total, page, pageSize);
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
