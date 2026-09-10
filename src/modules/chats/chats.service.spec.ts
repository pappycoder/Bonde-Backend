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
    findFirst: vi.fn(async () => CHAT),
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
  const service = new ChatsService(prisma as never);
  return { service, chat, message };
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
