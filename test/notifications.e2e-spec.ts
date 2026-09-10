import { randomUUID } from 'node:crypto';
import { NotificationStatus, NotificationType } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootE2EApp,
  SEED_OTHER_ID,
  SEED_USER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

describe('Notifications (self-service e2e)', () => {
  let ctx: BootedE2EApp;

  beforeEach(async () => {
    ctx = await bootE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
    await ctx.prisma.notification.deleteMany();
  });

  afterEach(async () => {
    await ctx.close();
  });

  async function seedNotification(
    userId: string,
    overrides: Partial<{ status: NotificationStatus }> = {},
  ) {
    return ctx.prisma.notification.create({
      data: {
        id: randomUUID(),
        userId,
        title: 'Card paused',
        content: 'Your card was paused.',
        type: NotificationType.CARD,
        status: overrides.status ?? NotificationStatus.UNREAD,
      },
    });
  }

  it('lists only the current user’s notifications, paged', async () => {
    await seedNotification(SEED_USER_ID);
    await seedNotification(SEED_USER_ID);
    await seedNotification(SEED_OTHER_ID);

    const res = await ctx.http.get('/notifications').expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items.every((n: { userId: string }) => n.userId === SEED_USER_ID)).toBe(true);
  });

  it('filters by status', async () => {
    await seedNotification(SEED_USER_ID, { status: NotificationStatus.READ });
    await seedNotification(SEED_USER_ID, { status: NotificationStatus.UNREAD });

    const res = await ctx.http
      .get('/notifications')
      .query({ status: NotificationStatus.UNREAD })
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].status).toBe(NotificationStatus.UNREAD);
  });

  it('marks a single notification read', async () => {
    const notification = await seedNotification(SEED_USER_ID);
    const res = await ctx.http.patch(`/notifications/${notification.id}/read`).expect(200);
    expect(res.body).toMatchObject({ status: NotificationStatus.READ });
    expect(res.body.readAt).toBeTruthy();
  });

  it('refuses to mark another user’s notification read (404)', async () => {
    const foreign = await seedNotification(SEED_OTHER_ID);
    const res = await ctx.http.patch(`/notifications/${foreign.id}/read`).expect(404);
    expect(res.body.statusCode).toBe(404);
  });

  it('marks all unread as read', async () => {
    await seedNotification(SEED_USER_ID);
    await seedNotification(SEED_USER_ID);
    const res = await ctx.http.patch('/notifications/read-all').expect(200);
    expect(res.body.updated).toBe(2);
  });
});
