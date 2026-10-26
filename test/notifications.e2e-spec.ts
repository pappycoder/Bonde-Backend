import { randomUUID } from 'node:crypto';
import { NotificationStatus, NotificationType } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { FinanceEvents } from '../src/modules/finance/finance-events.service.js';
import { SafeHavenClient } from '../src/modules/finance/providers.js';
import {
  bootFinanceE2EApp,
  seedFinanceFunds,
  executeFinance,
  financeTestEnvironment,
} from './finance-fixtures.js';
const restoreEnvironment = financeTestEnvironment(5);
afterAll(restoreEnvironment);
import {
  SEED_OTHER_ID,
  SEED_USER_ID,
  SEED_CARD_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

describe('Notifications (self-service e2e)', () => {
  let ctx: BootedE2EApp;
  beforeEach(async () => {
    ctx = await bootFinanceE2EApp({
      overrides: [
        {
          token: SafeHavenClient,
          useValue: {
            call: async (path: string) => {
              if (path !== '/transfers/tqs') throw new Error('Unexpected provider call');
              return {
                _id: 'verified-deposit',
                sessionId: 'verified-session',
                status: 'Completed',
                type: 'Inwards',
                account: 'test-bank-account',
                creditAccountNumber: '8061234567',
                amount: 100,
                fees: 0,
                vat: 0,
                stampDuty: 0,
              };
            },
          },
        },
      ],
    });
    const config = ctx.app.get(ConfigService);
    config.set('finance', { ...config.get('finance'), incomingFeeBearer: 'sender' });
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
    await seedFinanceFunds(ctx);
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

  it('creates a SYSTEM notification after a passcode-confirmed threshold setting', async () => {
    const operation = await executeFinance(ctx, {
      kind: 'THRESHOLDS',
      thresholdType: 'LARGE_AMOUNT',
      thresholdValue: '5000.00',
      thresholdActive: true,
    });
    expect(operation.status).toBe(201);
    const res = await ctx.http.get('/notifications').expect(200);
    expect(
      res.body.items.find(
        (row: { metadata: { operationId?: string } }) =>
          row.metadata?.operationId === operation.body.id,
      ),
    ).toMatchObject({
      type: NotificationType.SYSTEM,
      title: 'Action completed',
      metadata: { live: true, entityType: 'finance_operation' },
    });
  });
  it('notifies a verified bank deposit exactly once and credits the live wallet', async () => {
    await ctx.prisma.financeCustomer.create({
      data: {
        userId: SEED_USER_ID,
        bankAccountId: 'test-bank-account',
        bankAccountNumber: '8061234567',
        bankStatus: 'READY',
      },
    });
    const events = ctx.app.get(FinanceEvents);
    for (const deliveryId of ['first', 'duplicate']) {
      await events.receive('safe-haven', 'account.credit', 'verified-deposit', {
        sessionId: 'verified-session',
        deliveryId,
      });
      await events.run();
    }
    const res = await ctx.http.get('/notifications').expect(200);
    const deposits = res.body.items.filter(
      (row: { metadata: { reference?: string } }) =>
        row.metadata?.reference === 'deposit:verified-deposit',
    );
    expect(deposits).toHaveLength(1);
    expect(deposits[0]).toMatchObject({
      type: NotificationType.TRANSACTION,
      title: 'Funds received',
      content: '100.00 NGN',
    });
    expect((await ctx.http.get('/wallet').expect(200)).body.balance).toBe('200.00');
    await ctx.http.post('/transactions').send({ type: 'DEPOSIT', amount: '100.00' }).expect(404);
  });
  it('creates a CARD notification through the versioned card-rules command', async () => {
    const operation = await executeFinance(ctx, {
      kind: 'RULES',
      cardId: SEED_CARD_ID,
      rulesVersion: 1,
      nickname: 'Weekend spending',
      rules: { maxSpendLimit: '25.00' },
    });
    expect(operation.status).toBe(201);
    expect(operation.body.status).toBe('SUCCEEDED');
    const res = await ctx.http.get('/notifications').expect(200);
    expect(
      res.body.items.find(
        (row: { metadata: { operationId?: string } }) =>
          row.metadata?.operationId === operation.body.id,
      ),
    ).toMatchObject({
      type: NotificationType.CARD,
      title: 'Action completed',
      metadata: { live: true, entityType: 'finance_operation' },
    });
    expect((await ctx.http.get(`/cards/${SEED_CARD_ID}`).expect(200)).body).toMatchObject({
      nickname: 'Weekend spending',
      maxSpendLimit: '25.00',
      rulesVersion: 2,
    });
    await ctx.http.post('/cards').send({ nickname: 'Bypass' }).expect(404);
  });
});
