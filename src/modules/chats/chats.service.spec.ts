import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { MessageRole } from '@prisma/client';
import { ChatsService } from './chats.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CHAT_ID = '55555555-5555-4555-8555-555555555555';
const MESSAGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const chat = {
    findMany: vi.fn(async () => [CHAT]),
    count: vi.fn(async () => 1),
    create: vi.fn(async (args) => ({
      id: CHAT_ID,
      ...args.data,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    findFirst: vi.fn(async (_args: Record<string, unknown>): Promise<typeof CHAT | null> => CHAT),
    update: vi.fn(async (args) => ({ ...CHAT, ...args.data })),
    delete: vi.fn(async () => CHAT),
    ...overrides.chat,
  };
  const message = {
    findMany: vi.fn(async () => [MESSAGE]),
    count: vi.fn(async () => 1),
    create: vi.fn(async (args) => ({ id: MESSAGE_ID, ...args.data, createdAt: new Date() })),
    ...overrides.message,
  };
  const prisma = {
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    chat,
    message,
  };
  const service = new ChatsService(
    prisma as never,
    {
      submit: vi.fn(async (userId, chatId, content) => {
        if (!(await chat.findFirst({ where: { id: chatId, userId } })))
          throw new NotFoundException();
        return {
          message: await message.create({ data: { chatId, role: MessageRole.USER, content } }),
        };
      }),
    } as never,
  );
  return { service, chat, message, prisma };
}

const CHAT = {
  id: CHAT_ID,
  userId: USER_ID,
  title: 'Onboarding chat',
  createdAt: new Date(),
  updatedAt: new Date(),
};
const MESSAGE = {
  id: MESSAGE_ID,
  chatId: CHAT_ID,
  role: MessageRole.USER,
  content: 'Hello',
  createdAt: new Date(),
};

describe('ChatsService.list', () => {
  it('loads history without acquiring a transaction slot', async () => {
    const { service, prisma, chat } = makeService();
    prisma.$transaction.mockRejectedValue(
      new Error('Unable to start a transaction in the given time.'),
    );
    const result = await service.list(USER_ID, { page: 2, pageSize: 10, q: 'Travel' });
    expect(result).toMatchObject({ items: [CHAT], total: 1, page: 2, pageSize: 10 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(chat.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ userId: USER_ID }),
    });
    expect(chat.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
  });
  it('returns a paged envelope scoped to the user', async () => {
    const { service, chat } = makeService();
    const result = await service.list(USER_ID, { page: 1, pageSize: 20 });
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
    expect(chat.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
  });
});

describe('ChatsService.create', () => {
  it('creates a chat with the given title', async () => {
    const { service, chat } = makeService();
    await service.create(USER_ID, { title: 'Travel' });
    expect(chat.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: USER_ID, title: 'Travel' }),
      }),
    );
  });
});

describe('ChatsService.get', () => {
  it('404s for a chat the user does not own', async () => {
    const { service, chat } = makeService();
    chat.findFirst.mockResolvedValue(null);
    await expect(service.get(USER_ID, CHAT_ID)).rejects.toThrow(NotFoundException);
  });
});

describe('ChatsService.update', () => {
  it('renames an owned chat and 404s otherwise', async () => {
    const { service, chat } = makeService();
    chat.findFirst.mockResolvedValue(null);
    await expect(service.update(USER_ID, CHAT_ID, { title: 'x' })).rejects.toThrow(
      NotFoundException,
    );
    chat.findFirst.mockResolvedValue(CHAT);
    await expect(service.update(USER_ID, CHAT_ID, { title: 'Renamed' })).resolves.toMatchObject({
      title: 'Renamed',
    });
  });
});

describe('ChatsService.remove', () => {
  it('deletes an owned chat and reports it', async () => {
    const { service, chat } = makeService();
    chat.findFirst.mockResolvedValue(null);
    await expect(service.remove(USER_ID, CHAT_ID)).rejects.toThrow(NotFoundException);
    chat.findFirst.mockResolvedValue(CHAT);
    await expect(service.remove(USER_ID, CHAT_ID)).resolves.toEqual({ deleted: true, id: CHAT_ID });
  });
});

describe('ChatsService messages', () => {
  it('loads messages without acquiring a transaction slot and preserves filters', async () => {
    const { service, prisma, message } = makeService();
    prisma.$transaction.mockRejectedValue(
      new Error('Unable to start a transaction in the given time.'),
    );
    await expect(
      service.listMessages(USER_ID, CHAT_ID, { page: 2, pageSize: 5 }),
    ).resolves.toMatchObject({ items: [MESSAGE], total: 1, page: 2, pageSize: 5 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { chatId: CHAT_ID }, skip: 5, take: 5 }),
    );
    expect(message.count).toHaveBeenCalledWith({ where: { chatId: CHAT_ID } });
  });
  it('lists messages chronologically within a chat the user owns', async () => {
    const { service, chat, message } = makeService();
    chat.findFirst.mockResolvedValue(null);
    await expect(service.listMessages(USER_ID, CHAT_ID)).rejects.toThrow(NotFoundException);
    chat.findFirst.mockResolvedValue(CHAT);
    await expect(service.listMessages(USER_ID, CHAT_ID)).resolves.toMatchObject({ total: 1 });
    expect(message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId: CHAT_ID },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('always writes USER-role messages', async () => {
    const { service, message } = makeService();
    await service.createMessage(USER_ID, CHAT_ID, { content: 'Transfer 2000' });
    expect(message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: MessageRole.USER }) }),
    );
  });
});
