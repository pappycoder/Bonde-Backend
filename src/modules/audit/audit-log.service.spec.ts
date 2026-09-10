import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditLogService } from './audit-log.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ENTITY_ID = '22222222-2222-4222-8222-222222222222';

function makeService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const create = vi.fn(async (args) => args.data);
  const findMany = vi.fn(async () => [ROW]);
  const count = vi.fn(async () => 1);
  const findFirst = vi.fn(async () => ROW);
  const service = new AuditLogService({
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    auditLog: { create, findMany, count, findFirst, ...overrides },
  } as never);
  return { service, create, findMany, count, findFirst };
}

const ROW = {
  id: '33333333-3333-4333-8333-333333333333',
  userId: USER_ID,
  action: 'card.pause',
  entityType: 'card',
  entityId: ENTITY_ID,
  metadata: {},
  ipAddress: null,
  userAgent: null,
  createdAt: new Date(),
};

describe('AuditLogService.record', () => {
  it('creates an immutable audit row with a fresh UUID id', async () => {
    const { service, create } = makeService();
    await service.record({
      userId: USER_ID,
      action: 'profile.update',
      entityType: 'profile',
      entityId: ENTITY_ID,
    });
    const data = create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.data).toMatchObject({
      userId: USER_ID,
      action: 'profile.update',
      entityType: 'profile',
      entityId: ENTITY_ID,
    });
    expect(data.data.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('allows system actions without an actor', async () => {
    const { service, create } = makeService();
    await service.record({ action: 'system.bootstrap', entityType: 'wallet', entityId: ENTITY_ID });
    expect(create.mock.calls[0][0]).toHaveProperty('data.userId', null);
  });

  it('rejects malformed entity ids', async () => {
    const { service, create } = makeService();
    await expect(
      service.record({ action: 'x', entityType: 'profile', entityId: 'not-a-uuid' }),
    ).rejects.toThrow(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects empty actions and entity types', async () => {
    const { service, create } = makeService();
    await expect(
      service.record({ action: '   ', entityType: 'profile', entityId: ENTITY_ID }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.record({ action: 'x', entityType: '', entityId: ENTITY_ID }),
    ).rejects.toThrow(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('AuditLogService.listForUser', () => {
  it('returns a paged envelope scoped to the caller', async () => {
    const { service, findMany, count } = makeService();
    const result = await service.listForUser(USER_ID, { page: 1, pageSize: 20 });
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID }, orderBy: { createdAt: 'desc' } }),
    );
    expect(count).toHaveBeenCalledWith({ where: { userId: USER_ID } });
  });
});

describe('AuditLogService.getForUser', () => {
  it('404s for an entry the caller does not own', async () => {
    const { service, findFirst } = makeService();
    findFirst.mockResolvedValue(null);
    await expect(service.getForUser(USER_ID, ROW.id)).rejects.toThrow(NotFoundException);
  });
});
