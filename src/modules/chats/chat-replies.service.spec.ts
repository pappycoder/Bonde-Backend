import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ChatRepliesService } from './chat-replies.service.js';
import { UnconfiguredChatAgent } from './chat-agent.js';
const USER = '11111111-1111-4111-8111-111111111111',
  CHAT = '22222222-2222-4222-8222-222222222222',
  USER_MESSAGE = '33333333-3333-4333-8333-333333333333',
  ASSISTANT = '44444444-4444-4444-8444-444444444444',
  ITEM = '55555555-5555-4555-8555-555555555555',
  APPROVAL = '66666666-6666-4666-8666-666666666666';
function setup({ approvalId = APPROVAL, amount = '349.00' } = {}) {
  const item = {
    id: ITEM,
    title: 'Headphones',
    merchant: 'Shop',
    amount,
    currency: 'USD',
    authorizedLimit: '350.00',
    approvalId,
    decision: 'PENDING',
  };
  const envelope = { version: 1, replyTo: USER_MESSAGE, text: 'Found an option', items: [item] };
  const message = {
    id: ASSISTANT,
    chatId: CHAT,
    role: 'ASSISTANT',
    content: JSON.stringify(envelope),
    createdAt: new Date(),
  };
  const prisma = {
    chat: {
      findFirst: vi.fn(async () => ({ id: CHAT, userId: USER })),
      update: vi.fn(async () => ({ id: CHAT })),
    },
    message: {
      findMany: vi.fn(async () => [
        { id: USER_MESSAGE, role: 'USER', content: 'Find headphones', createdAt: new Date() },
      ]),
      findFirst: vi.fn(async () => message),
      create: vi.fn(async (args) => ({ id: ASSISTANT, ...args.data })),
      update: vi.fn(async () => message),
    },
    transactionApproval: {
      findFirst: vi.fn(async () => ({
        id: APPROVAL,
        status: 'PENDING',
        transaction: { amount: new Prisma.Decimal('349.00'), currency: 'USD' },
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $queryRaw: vi.fn(async () => [{ id: CHAT }]),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  const agent = {
    reply: vi.fn(async () => ({
      text: 'Found options',
      items: [
        {
          title: 'Headphones',
          merchant: 'Shop',
          amount: '349.00',
          currency: 'USD',
          specifications: { Color: 'Silver' },
        },
      ],
    })),
  };
  return {
    prisma,
    agent,
    message,
    envelope,
    service: new ChatRepliesService(prisma as never, agent as never),
  };
}
describe('chat assistant replies', () => {
  it('unconfigured AI reports 503 without inventing results', async () => {
    await expect(new UnconfiguredChatAgent().reply()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
  it('rejects unowned chats before invoking the AI', async () => {
    const { service, prisma, agent } = setup();
    prisma.chat.findFirst.mockResolvedValue(null as never);
    await expect(service.respond(USER, CHAT, USER_MESSAGE)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(agent.reply).not.toHaveBeenCalled();
  });
  it('returns an existing response on retry without generating another reply', async () => {
    const { service, prisma, agent, message } = setup();
    prisma.message.findMany.mockResolvedValue([message] as never);
    expect(await service.respond(USER, CHAT, USER_MESSAGE)).toEqual(message);
    expect(agent.reply).not.toHaveBeenCalled();
  });
  it('validates real engine results and persists an ASSISTANT envelope with server item IDs', async () => {
    const { service, prisma } = setup();
    prisma.message.findMany
      .mockResolvedValueOnce([
        { id: USER_MESSAGE, role: 'USER', content: 'Find headphones' },
      ] as never)
      .mockResolvedValueOnce([]);
    const result = await service.respond(USER, CHAT, USER_MESSAGE);
    expect(result.role).toBe('ASSISTANT');
    const reply = JSON.parse(result.content);
    expect(reply.items).toHaveLength(1);
    expect(reply.items[0].id).toMatch(/^[a-f0-9-]{36}$/);
    expect(reply.replyTo).toBe(USER_MESSAGE);
    expect(reply.items[0].decision).toBe('PENDING');
  });
  it('rejects invalid item prices before saving an assistant reply', async () => {
    const { service, agent, prisma } = setup();
    agent.reply.mockResolvedValue({
      text: 'Found options',
      items: [{ title: 'Invalid', merchant: 'Shop', amount: '-3', currency: 'USD' }],
    } as never);
    await expect(service.respond(USER, CHAT, USER_MESSAGE)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(prisma.message.create).not.toHaveBeenCalled();
  });
});
describe('chat purchase decisions', () => {
  it('requires an owned chat before any purchase decision', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.decide(USER, CHAT, ASSISTANT, ITEM, 'APPROVED')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.transactionApproval.updateMany).not.toHaveBeenCalled();
  });
  it('matches approval by owner, chat, exact price and currency', async () => {
    const { service, prisma } = setup();
    await service.decide(USER, CHAT, ASSISTANT, ITEM, 'APPROVED');
    expect(prisma.transactionApproval.findFirst).toHaveBeenCalledWith({
      where: { id: APPROVAL, transaction: { userId: USER, chatId: CHAT } },
      include: { transaction: true },
    });
    expect(prisma.transactionApproval.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PENDING' }),
        data: { status: 'APPROVED', approvedBy: USER },
      }),
    );
  });
  it('cannot approve an item without a server purchase request', async () => {
    const { service, prisma } = setup({ approvalId: undefined });
    const message = await prisma.message.findFirst();
    const envelope = JSON.parse(message.content);
    delete envelope.items[0].approvalId;
    message.content = JSON.stringify(envelope);
    await expect(service.decide(USER, CHAT, ASSISTANT, ITEM, 'APPROVED')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.transactionApproval.updateMany).not.toHaveBeenCalled();
  });
  it('rejects quotes whose amount differs from the server approval', async () => {
    const { service, prisma } = setup({ amount: '300.00' });
    await expect(service.decide(USER, CHAT, ASSISTANT, ITEM, 'APPROVED')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.transactionApproval.updateMany).not.toHaveBeenCalled();
  });
  it('persists cancellation without creating a purchase', async () => {
    const { service, prisma, message } = setup();
    const envelope = JSON.parse(message.content);
    delete envelope.items[0].approvalId;
    message.content = JSON.stringify(envelope);
    await service.decide(USER, CHAT, ASSISTANT, ITEM, 'DECLINED');
    expect(prisma.transactionApproval.updateMany).not.toHaveBeenCalled();
    expect(JSON.parse(prisma.message.update.mock.calls[0][0].data.content).items[0].decision).toBe(
      'DECLINED',
    );
  });
  it('rejects proposals targeting another user or chat approval', async () => {
    const { service, prisma } = setup();
    prisma.transactionApproval.findFirst.mockResolvedValue(null as never);
    await expect(service.decide(USER, CHAT, ASSISTANT, ITEM, 'APPROVED')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.transactionApproval.updateMany).not.toHaveBeenCalled();
  });
});
