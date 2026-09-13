import { describe, it, expect, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  MethodNotAllowedException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CrudService } from './crud.service.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';

interface FakeDelegate {
  create?: ReturnType<typeof vi.fn>;
  findUnique?: ReturnType<typeof vi.fn>;
  findMany?: ReturnType<typeof vi.fn>;
  count?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
}

function makeService(delegates: Record<string, FakeDelegate> = {}): {
  service: CrudService;
  delegates: Record<string, Required<FakeDelegate>>;
} {
  const prisma = { ...delegates };
  const service = new CrudService(prisma as never);
  return { service, delegates: prisma as unknown as Record<string, Required<FakeDelegate>> };
}

function prismaError(code: string, message = 'prisma error'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: '7.10.0' });
}

describe('CrudService.create', () => {
  it('rejects unknown resources', async () => {
    const { service } = makeService();
    await expect(service.create('nope', {})).rejects.toThrow(NotFoundException);
  });

  it('enforces required fields on create', async () => {
    const { service } = makeService({ Chat: {} });
    await expect(service.create('chats', { title: 'Hi' })).rejects.toThrow(/user/);
    await expect(service.create('chats', { title: 'Hi' })).rejects.toThrow(BadRequestException);
  });

  it('rejects unknown fields', async () => {
    const { service } = makeService({ Chat: {} });
    await expect(service.create('chats', { userId: UUID, nonsense: 1 })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects non-writable fields (server-managed id)', async () => {
    const { service } = makeService({ Chat: {} });
    await expect(service.create('chats', { id: OTHER_UUID, userId: UUID })).rejects.toThrow(
      'not writable',
    );
  });

  it('rejects messages.write on audit-logs (append-only)', async () => {
    const { service } = makeService({});
    await expect(service.create('audit-logs', {})).rejects.toThrow(MethodNotAllowedException);
  });

  it('coerces enums, decimals and datetimes', async () => {
    const locks: FakeDelegate = { create: vi.fn(async (args) => args.data) };
    const { service } = makeService({ CardLock: locks });
    const created = await service.create('card-locks', {
      cardId: UUID,
      lockType: 'TIME',
      config: { maxMinutes: 30 },
      isActive: true,
    });
    expect(locks.create).toHaveBeenCalledTimes(1);
    expect(created).toHaveProperty('config.maxMinutes', 30);
  });

  it('rejects invalid enum values', async () => {
    const { service } = makeService({ CardLock: {} });
    await expect(service.create('card-locks', { cardId: UUID, lockType: 'NOPE' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects card-providers config as unknown (secrets are never writable)', async () => {
    const { service } = makeService({ CardProvider: {} });
    await expect(
      service.create('card-providers', { name: 'x', baseUrl: 'https://x', config: { key: 'a' } }),
    ).rejects.toThrow('Unknown field "config"');
  });

  it('maps unique-violation to 409', async () => {
    const { service } = makeService({
      CardProvider: { create: vi.fn(async () => Promise.reject(prismaError('P2002'))) },
    });
    await expect(
      service.create('card-providers', { name: 'x', baseUrl: 'https://x' }),
    ).rejects.toThrow(ConflictException);
  });

  it('maps referential-integrity failure to 400', async () => {
    const { service } = makeService({
      Message: { create: vi.fn(async () => Promise.reject(prismaError('P2003'))) },
    });
    await expect(
      service.create('messages', { chatId: UUID, role: 'USER', content: 'hi' }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('CrudService.get / update / delete', () => {
  it('returns 404 for a missing record', async () => {
    const { service } = makeService({ Notification: { findUnique: vi.fn(async () => null) } });
    await expect(service.get('notifications', UUID)).rejects.toThrow(NotFoundException);
  });

  it('serializes Decimal and Date in responses', async () => {
    const thresholds: FakeDelegate = {
      findUnique: vi.fn(async () => ({
        id: UUID,
        userId: UUID,
        thresholdType: 'LARGE_AMOUNT',
        thresholdValue: new Prisma.Decimal('150.50'),
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      })),
    };
    const { service } = makeService({ TransactionThreshold: thresholds });
    const record = (await service.get('transaction-thresholds', UUID)) as Record<string, unknown>;
    expect(record.thresholdValue).toBe('150.50');
    expect(record.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('never returns card-providers.config on get', async () => {
    const providers: FakeDelegate = {
      findUnique: vi.fn(async () => ({
        id: UUID,
        name: 'p',
        baseUrl: 'https://p',
        isActive: true,
        config: { secret: 'leak' },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    };
    const { service } = makeService({ CardProvider: providers });
    const record = (await service.get('card-providers', UUID)) as Record<string, unknown>;
    expect(record).not.toHaveProperty('config');
    expect(record.name).toBe('p');
  });

  it('maps update of a missing record to 404', async () => {
    const { service } = makeService({
      Chat: { update: vi.fn(async () => Promise.reject(prismaError('P2025'))) },
    });
    await expect(service.update('chats', UUID, { title: 'x' })).rejects.toThrow(NotFoundException);
  });

  it('updates one or more writable fields', async () => {
    const chats: FakeDelegate = {
      update: vi.fn(async ({ data }) => ({
        id: UUID,
        userId: UUID,
        title: data.title,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      })),
    };
    const { service } = makeService({ Chat: chats });
    const record = (await service.update('chats', UUID, { title: 'Renamed' })) as Record<
      string,
      unknown
    >;
    expect(record.title).toBe('Renamed');
    expect(chats.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: UUID },
        data: expect.objectContaining({ title: 'Renamed' }),
      }),
    );
  });

  it('hard-deletes and reports the id', async () => {
    const { service } = makeService({ Chat: { delete: vi.fn(async () => ({ id: UUID })) } });
    await expect(service.remove('chats', UUID)).resolves.toEqual({ deleted: true, id: UUID });
  });

  it('delete of a missing record maps to 404', async () => {
    const { service } = makeService({
      Chat: { delete: vi.fn(async () => Promise.reject(prismaError('P2025'))) },
    });
    await expect(service.remove('chats', UUID)).rejects.toThrow(NotFoundException);
  });
});

describe('CrudService.list', () => {
  it('paginates with defaults', async () => {
    const { service } = makeService({
      Chat: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    });
    const result = (await service.list('chats')) as Record<string, unknown>;
    expect(result).toMatchObject({ items: [], total: 0, totalPages: 0 });
  });

  it('passes filters and orderBy through', async () => {
    const chats: FakeDelegate = { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) };
    const { service } = makeService({ Chat: chats });
    await service.list('chats', {
      filters: 'userId:11111111-1111-4111-8111-111111111111',
      orderBy: 'createdAt:asc',
    });
    expect(chats.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: UUID },
        orderBy: { createdAt: 'asc' },
        skip: 0,
        take: 20,
      }),
    );
  });

  it('accepts repeated filter params (string fields partial-match by default)', async () => {
    const chats: FakeDelegate = { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) };
    const { service } = makeService({ Chat: chats });
    await service.list('chats', {
      filters: ['userId:11111111-1111-4111-8111-111111111111', 'title:Hello'],
    });
    expect(chats.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: UUID,
          title: { contains: 'Hello', mode: 'insensitive' },
        },
      }),
    );
  });

  it('rejects filters on unknown or hidden fields', async () => {
    const { service } = makeService({ CardProvider: { findMany: vi.fn(), count: vi.fn() } });
    await expect(service.list('card-providers', { filters: 'config:secret' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects bad orderBy values', async () => {
    const { service } = makeService({ Chat: { findMany: vi.fn(), count: vi.fn() } });
    await expect(service.list('chats', { orderBy: 'createdAt:sideways' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.list('chats', { orderBy: 'nope:asc' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('searches with q across the searchable fields', async () => {
    const chats: FakeDelegate = { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) };
    const { service } = makeService({ Chat: chats });
    await service.list('chats', { q: 'holiday', page: 1, pageSize: 20 });
    expect(chats.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ title: { contains: 'holiday', mode: 'insensitive' } }] },
      }),
    );
  });

  it('combines q search with filter operators', async () => {
    const messages: FakeDelegate = { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) };
    const { service } = makeService({ Message: messages });
    await service.list('messages', {
      q: 'hello',
      filters: 'role:eq:USER',
      page: 1,
      pageSize: 20,
    });
    expect(messages.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          role: 'USER',
          OR: [{ content: { contains: 'hello', mode: 'insensitive' } }],
        },
      }),
    );
  });

  it('supports textual operators on string fields', async () => {
    const chats: FakeDelegate = { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) };
    const { service } = makeService({ Chat: chats });
    await service.list('chats', { filters: 'title:startsWith:vac', page: 1, pageSize: 20 });
    expect(chats.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { title: { startsWith: 'vac', mode: 'insensitive' } },
      }),
    );
  });

  it('rejects operators not allowed on the field kind', async () => {
    const { service } = makeService({ Chat: { findMany: vi.fn(), count: vi.fn() } });
    await expect(service.list('chats', { filters: 'userId:contains:11' })).rejects.toThrow(
      'Operator "contains" is not allowed',
    );
  });

  it('rejects q on resources with no searchable fields', async () => {
    const { service } = makeService({ CardLock: { findMany: vi.fn(), count: vi.fn() } });
    await expect(service.list('card-locks', { q: 'x' })).rejects.toThrow(BadRequestException);
  });
});
