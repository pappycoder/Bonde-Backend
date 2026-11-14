import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SubscriptionReminders } from '../src/modules/chats/subscription-reminders.service.js';
import { prepareSubscriptionCheckout } from '../src/modules/chats/subscription-catalog.js';
import {
  bootE2EApp,
  SEED_CHAT_ID,
  SEED_USER_ID,
  SEED_OTHER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

describe('subscription assistance reminders (e2e)', () => {
  let ctx: BootedE2EApp;
  let reminders: SubscriptionReminders;
  beforeAll(async () => {
    ctx = await bootE2EApp();
    reminders = ctx.app.get(SubscriptionReminders);
    reminders.onModuleDestroy();
  });
  afterAll(async () => {
    if (ctx) await ctx.close();
  });
  beforeEach(async () => {
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
    ctx.setPrincipal();
  });
  async function source() {
    const card = prepareSubscriptionCheckout('netflix', 'NG', 'RENEW');
    const message = await ctx.prisma.message.create({
      data: {
        id: randomUUID(),
        chatId: SEED_CHAT_ID,
        role: 'ASSISTANT',
        content: JSON.stringify({
          version: 1,
          text: 'Review account',
          items: [],
          subscriptions: [card],
        }),
      },
    });
    return {
      messageId: message.id,
      subscriptionId: card.id,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }
  it('creates, replaces, lists and cancels an owned reminder without AI credits or a payment', async () => {
    const payload = await source();
    const created = await ctx.http.post('/subscription-reminders').send(payload).expect(201);
    const replaced = await ctx.http
      .post('/subscription-reminders')
      .send({ ...payload, dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString() })
      .expect(201);
    expect(replaced.body.id).toBe(created.body.id);
    const list = await ctx.http.get('/subscription-reminders').expect(200);
    expect(list.body).toHaveLength(1);
    await ctx.http.delete(`/subscription-reminders/${created.body.id}`).expect(200);
    expect((await ctx.http.get('/subscription-reminders')).body).toEqual([]);
    expect(await ctx.prisma.aiCreditEntry.count({ where: { userId: SEED_USER_ID } })).toBe(0);
    expect(await ctx.prisma.financeOperation.count({ where: { userId: SEED_USER_ID } })).toBe(0);
  });
  it('rejects unowned message cards and unowned cancellation', async () => {
    const payload = await source();
    const owned = await reminders.schedule(
      SEED_USER_ID,
      payload.messageId,
      payload.subscriptionId,
      new Date(payload.dueAt),
    );
    ctx.setPrincipal({ userId: SEED_OTHER_ID });
    await ctx.http.post('/subscription-reminders').send(payload).expect(404);
    await ctx.http.delete(`/subscription-reminders/${owned.id}`).expect(404);
    expect((await ctx.http.get('/subscription-reminders')).body).toEqual([]);
  });
  it('delivers once across concurrent workers', async () => {
    const payload = await source();
    const reminder = await reminders.schedule(
      SEED_USER_ID,
      payload.messageId,
      payload.subscriptionId,
      new Date(payload.dueAt),
    );
    await ctx.prisma.subscriptionReminder.update({
      where: { id: reminder.id },
      data: { dueAt: new Date(Date.now() - 1000) },
    });
    await Promise.all([reminders.run(), reminders.run()]);
    expect(
      await ctx.prisma.notification.count({
        where: { userId: SEED_USER_ID, title: 'Netflix reminder' },
      }),
    ).toBe(1);
    expect(
      (await ctx.prisma.subscriptionReminder.findUniqueOrThrow({ where: { id: reminder.id } }))
        .status,
    ).toBe('SENT');
  });
  it('rejects forged fields and invalid dates through HTTP validation', async () => {
    const payload = await source();
    await ctx.http
      .post('/subscription-reminders')
      .send({ ...payload, checkoutUrl: 'https://evil.test' })
      .expect(400);
    await ctx.http
      .post('/subscription-reminders')
      .send({ ...payload, dueAt: 'invalid' })
      .expect(400);
  });
});
