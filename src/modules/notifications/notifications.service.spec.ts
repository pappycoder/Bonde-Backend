import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { NotificationStatus, NotificationType } from '@prisma/client';
import { NotificationsService } from './notifications.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOTIF_ID = '22222222-2222-4222-8222-222222222222';

function makeService(
  delegates: {
    findMany?: ReturnType<typeof vi.fn>;
    count?: ReturnType<typeof vi.fn>;
    findUnique?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
    updateMany?: ReturnType<typeof vi.fn>;
    create?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const prisma = {
    notification: {
      findMany: delegates.findMany ?? vi.fn(async () => []),
      count: delegates.count ?? vi.fn(async () => 0),
      findUnique: delegates.findUnique ?? vi.fn(async () => null),
      update: delegates.update ?? vi.fn(async (args) => ({ ...args.data, id: args.where.id })),
      updateMany: delegates.updateMany ?? vi.fn(async () => ({ count: 0 })),
      create: delegates.create ?? vi.fn(async (args) => ({ ...args.data })),
    },
    $transaction: vi.fn(async (promises: Promise<unknown>[]) => Promise.all(promises)),
  };
  return { service: new NotificationsService(prisma as never), prisma };
}

describe('NotificationsService.create', () => {
  it('creates a notification for a user with a UUID id', async () => {
    const { service, prisma } = makeService();
    await service.create({ targetUserId: USER_ID, title: 'T', content: 'C' });
    const call = prisma.notification.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.data).toMatchObject({
      userId: USER_ID,
      title: 'T',
      content: 'C',
      type: NotificationType.SYSTEM,
    });
  });
});

describe('NotificationsService.list', () => {
  it('paginates and applies the status filter', async () => {
    const findMany = vi.fn(async () => []);
    const count = vi.fn(async () => 1);
    const { service, prisma } = makeService({ findMany, count });
    await service.list(USER_ID, { status: NotificationStatus.UNREAD, page: 2, pageSize: 10 });

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, status: NotificationStatus.UNREAD },
      orderBy: { createdAt: 'desc' },
      skip: 10,
      take: 10,
    });
    expect(count).toHaveBeenCalledWith({
      where: { userId: USER_ID, status: NotificationStatus.UNREAD },
    });
    expect(prisma).toBeDefined();
  });
});

describe('NotificationsService.markRead', () => {
  it('404s when the notification is not the user’s own', async () => {
    const { service } = makeService({
      findUnique: vi.fn(async () => ({
        id: NOTIF_ID,
        userId: '99999999-9999-4999-8999-999999999999',
      })),
    });
    await expect(service.markRead(USER_ID, NOTIF_ID)).rejects.toThrow(NotFoundException);
  });

  it('marks a read and stamps readAt', async () => {
    const update = vi.fn(async (args) => ({ id: args.where.id, ...args.data }));
    const { service } = makeService({
      findUnique: vi.fn(async () => ({ id: NOTIF_ID, userId: USER_ID })),
      update,
    });
    const result = await service.markRead(USER_ID, NOTIF_ID);
    expect(result).toMatchObject({ status: NotificationStatus.READ });
    expect(update).toHaveBeenCalledWith({
      where: { id: NOTIF_ID },
      data: { status: NotificationStatus.READ, readAt: expect.any(Date) },
    });
  });
});

describe('NotificationsService.markAllRead', () => {
  it('bulk-updates only unread rows and reports the count', async () => {
    const updateMany = vi.fn(async () => ({ count: 7 }));
    const { service } = makeService({ updateMany });
    await expect(service.markAllRead(USER_ID)).resolves.toEqual({ updated: 7 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, status: NotificationStatus.UNREAD },
      data: { status: NotificationStatus.READ, readAt: expect.any(Date) },
    });
  });
});
