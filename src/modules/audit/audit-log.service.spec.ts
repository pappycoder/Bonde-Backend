import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { AuditLogService } from './audit-log.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ENTITY_ID = '22222222-2222-4222-8222-222222222222';

function makeService() {
  const create = vi.fn(async (args) => args.data);
  const service = new AuditLogService({ auditLog: { create } } as never);
  return { service, create };
}

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
