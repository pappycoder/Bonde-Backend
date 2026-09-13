import { randomUUID } from 'node:crypto';
import { NotificationStatus, NotificationType } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAIL_SENDER, type MailMessage, type MailSender } from '../src/common/mail/mail.types.js';
import {
  bootE2EApp,
  SEED_OTHER_ID,
  SEED_USER_ID,
  SEED_WALLET_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

describe('Notifications (self-service e2e)', () => {
  let ctx: BootedE2EApp;
  const sentMails: MailMessage[] = [];
  const mailSender: MailSender = {
    send: async (message) => {
      sentMails.push(message);
    },
  };

  beforeEach(async () => {
    sentMails.length = 0;
    ctx = await bootE2EApp({ overrides: [{ token: MAIL_SENDER, useValue: mailSender }] });
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
      .query({ filter: `status:${NotificationStatus.UNREAD}` })
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

  it('creates a SYSTEM notification when a threshold is created', async () => {
    const created = await ctx.http
      .post('/thresholds')
      .send({ thresholdType: 'LARGE_AMOUNT', thresholdValue: '5000.00' })
      .expect(201);

    const res = await ctx.http.get('/notifications').expect(200);
    const notification = res.body.items.find(
      (n: { metadata: { entityId?: string }; type: NotificationType }) =>
        n.metadata?.entityId === created.body.id,
    );
    expect(notification).toMatchObject({
      type: NotificationType.SYSTEM,
      title: 'Threshold created',
    });
    expect(notification.content).toContain('large amount threshold was set at 5000.00');
  });

  it('creates a TRANSACTION notification when a transaction is created', async () => {
    const created = await ctx.http
      .post('/transactions')
      .send({ walletId: SEED_WALLET_ID, type: 'DEPOSIT', amount: '100.00' })
      .expect(201);

    const res = await ctx.http.get('/notifications').expect(200);
    const notification = res.body.items.find(
      (n: { metadata: { entityId?: string }; type: NotificationType }) =>
        n.metadata?.entityId === created.body.id,
    );
    expect(notification).toMatchObject({
      type: NotificationType.TRANSACTION,
      title: 'Transaction recorded',
    });
    expect(notification.content).toContain('deposit of 100.00 NGN');
  });

  it('creates a CARD notification when a card is created', async () => {
    const created = await ctx.http
      .post('/cards')
      .send({ cardType: 'virtual', nickname: 'Weekend spending' })
      .expect(201);

    const res = await ctx.http.get('/notifications').expect(200);
    const notification = res.body.items.find(
      (n: { metadata: { entityId?: string }; type: NotificationType }) =>
        n.metadata?.entityId === created.body.id,
    );
    expect(notification).toMatchObject({
      type: NotificationType.CARD,
      title: 'Card created',
    });
    expect(notification.content).toContain('"Weekend spending" card ending in');
    expect(notification.content).toContain('was created and is ready to use');
  });
});
