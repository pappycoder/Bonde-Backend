import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminConsoleSupportService } from './admin-console-support.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const TICKET_ID = '10101010-1010-4101-8101-101010101010';
const MESSAGE_ID = '20202020-2020-4202-8202-202020202020';

function ticketRow() {
  return {
    id: TICKET_ID,
    userId: USER_ID,
    subject: 'Withdrawal blocked',
    priority: 'URGENT',
    status: 'OPEN',
    assigneeId: null,
    createdAt: new Date('2026-09-08T09:42:00.000Z'),
    updatedAt: new Date('2026-09-08T09:42:00.000Z'),
    user: { id: USER_ID, fullName: 'Olivia Martin', email: 'olivia@bonde.ai' },
    assignee: null,
    _count: { messages: 1 },
  };
}

function ticketWithMessages(status: string = 'OPEN') {
  return {
    ...ticketRow(),
    status,
    _count: { messages: 2 },
    messages: [
      {
        id: MESSAGE_ID,
        role: 'USER',
        body: 'Withdrawal is blocked.',
        createdAt: new Date('2026-09-08T09:00:00.000Z'),
      },
      {
        id: '30303030-3030-4303-8303-303030303030',
        role: 'SUPPORT',
        body: 'We are on it.',
        createdAt: new Date('2026-09-08T09:30:00.000Z'),
      },
    ],
  };
}

function makeService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const supportTicket = {
    findMany: vi.fn(async () => [ticketRow()]),
    count: vi.fn(async () => 1),
    findUnique: vi.fn(async () => ticketWithMessages()),
    create: vi.fn(async (args: { data: { id: string } }) => ({ ...ticketRow(), id: args.data.id })),
    update: vi.fn(async (): Promise<unknown> => ({})),
    ...overrides.supportTicket,
  };
  const supportMessage = {
    create: vi.fn(async () => ({ id: MESSAGE_ID })),
    ...overrides.supportMessage,
  };
  const profile = {
    findUnique: vi.fn(async () => ({ id: USER_ID })),
    ...overrides.profile,
  };
  const audit = {
    record: vi.fn(async (): Promise<void> => undefined),
    ...overrides.audit,
  };
  const prisma = {
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    supportTicket,
    supportMessage,
    profile,
  };
  const service = new AdminConsoleSupportService(prisma as never, audit as never);
  return { service, supportTicket, supportMessage, profile, audit };
}

describe('AdminConsoleSupportService', () => {
  it('lists tickets newest-activity-first with the user include', async () => {
    const { service, supportTicket } = makeService();
    const result = await service.list({ page: 2, pageSize: 10 });
    expect(result).toMatchObject({ total: 1, page: 2, pageSize: 10, totalPages: 1 });
    expect(result.items[0]).toMatchObject({
      id: TICKET_ID,
      user: 'Olivia Martin',
      priority: 'URGENT',
      status: 'OPEN',
      assignee: null,
      messageCount: 1,
    });
    expect(supportTicket.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { updatedAt: 'desc' },
      skip: 10,
      take: 10,
      include: {
        user: { select: { id: true, fullName: true, email: true } },
        assignee: { select: { fullName: true } },
        _count: { select: { messages: true } },
      },
    });
  });

  it('combines a status filter with a subject/user search', async () => {
    const { service, supportTicket } = makeService();
    await service.list({ q: 'withdrawal', status: 'OPEN' });
    const where = supportTicket.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('OPEN');
    expect(where.OR).toEqual([
      { subject: { contains: 'withdrawal', mode: 'insensitive' } },
      { user: { fullName: { contains: 'withdrawal', mode: 'insensitive' } } },
      { user: { email: { contains: 'withdrawal', mode: 'insensitive' } } },
    ]);
  });

  it('serializes the get() conversation oldest-first', async () => {
    const { service } = makeService();
    const detail = await service.get(TICKET_ID);
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0]).toMatchObject({
      role: 'USER',
      body: 'Withdrawal is blocked.',
      createdAt: '2026-09-08T09:00:00.000Z',
    });
  });

  it('throws 404 for an unknown ticket', async () => {
    const { service, supportTicket } = makeService();
    supportTicket.findUnique.mockResolvedValue(null);
    await expect(service.get(TICKET_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('creates a ticket with an optional first message and audits the action', async () => {
    const { service, supportMessage, audit } = makeService();
    await service.create(ACTOR_ID, {
      userId: USER_ID,
      subject: 'Request a limit increase',
      priority: 'LOW',
      message: 'Please raise my daily limit.',
    });
    expect(supportMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ticketId: expect.any(String),
          role: 'USER',
          body: 'Please raise my daily limit.',
        }),
      }),
    );
    expect(supportMessage.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith({
      userId: ACTOR_ID,
      action: 'admin.support.create',
      entityType: 'support-ticket',
      entityId: expect.any(String),
      metadata: { subject: 'Request a limit increase' },
    });
  });

  it('skips the first message and rejects an unknown user on create', async () => {
    const { service, profile, supportMessage } = makeService();
    profile.findUnique.mockResolvedValue(null);
    await expect(
      service.create(ACTOR_ID, { userId: USER_ID, subject: 'Hello' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(supportMessage.create).not.toHaveBeenCalled();
  });

  it('appends a SUPPORT reply and touches the ticket updatedAt', async () => {
    const { service, supportMessage, supportTicket, audit } = makeService();
    const result = await service.reply(TICKET_ID, ACTOR_ID, 'Thanks — checking now.');
    expect(supportMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ticketId: TICKET_ID,
          role: 'SUPPORT',
          body: 'Thanks — checking now.',
        }),
      }),
    );
    expect(supportTicket.update).toHaveBeenCalledWith({
      where: { id: TICKET_ID },
      data: expect.objectContaining({ updatedAt: expect.any(Date) }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.support.reply', entityId: TICKET_ID }),
    );
    expect(result.messages).toHaveLength(2);
  });

  it('rejects a reply on a resolved ticket', async () => {
    const { service, supportTicket } = makeService();
    supportTicket.findUnique.mockResolvedValue({ id: TICKET_ID, status: 'RESOLVED' });
    await expect(service.reply(TICKET_ID, ACTOR_ID, 'Hello')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('is an idempotent no-op when the status already matches', async () => {
    const { service, supportTicket, audit } = makeService();
    await service.changeStatus(TICKET_ID, ACTOR_ID, 'OPEN');
    expect(supportTicket.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('updates and audits a status transition', async () => {
    const { service, supportTicket, audit } = makeService();
    supportTicket.findUnique
      .mockResolvedValueOnce({ ...ticketWithMessages(), status: 'OPEN' })
      .mockResolvedValueOnce({ ...ticketWithMessages(), status: 'RESOLVED' });
    const result = await service.changeStatus(TICKET_ID, ACTOR_ID, 'RESOLVED');
    expect(supportTicket.update).toHaveBeenCalledWith({
      where: { id: TICKET_ID },
      data: { status: 'RESOLVED' },
    });
    expect(audit.record).toHaveBeenCalledWith({
      userId: ACTOR_ID,
      action: 'admin.support.status',
      entityType: 'support-ticket',
      entityId: TICKET_ID,
      metadata: { from: 'OPEN', to: 'RESOLVED' },
    });
    expect(result.status).toBe('RESOLVED');
  });
});
