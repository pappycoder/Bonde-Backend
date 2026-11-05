import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ChatWorker } from '../src/modules/chats/chat-worker.service.js';
import { ChatTurnsService } from '../src/modules/chats/chat-turns.service.js';
import { AiCreditsService } from '../src/modules/billing/ai-credits.service.js';
import { BillingService } from '../src/modules/billing/billing.service.js';
import {
  bootE2EApp,
  SEED_CHAT_ID,
  SEED_USER_ID,
  SEED_OTHER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

/** Real Postgres row locks and uniqueness constraints, not simulated concurrency. */
describe('AI credit admission and settlement (e2e)', () => {
  let ctx: BootedE2EApp;
  let turns: ChatTurnsService;
  beforeAll(async () => {
    ctx = await bootE2EApp();
    turns = ctx.app.get(ChatTurnsService);
    turns.onModuleDestroy();
    ctx.app.get(ChatWorker).onModuleDestroy();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
  });
  async function balance(welcome = 1, plan = 0, purchased = 0, periodEnd: Date | null = null) {
    await ctx.prisma.aiCreditAccount.create({
      data: {
        userId: SEED_USER_ID,
        welcomeRemaining: welcome,
        planRemaining: plan,
        planGranted: plan,
        purchasedRemaining: purchased,
        periodEnd,
      },
    });
  }
  const content = JSON.stringify({
    version: 1,
    text: 'Here are your shopping options.',
    items: [],
  });
  it('admits only one turn against the final credit across simultaneous requests', async () => {
    await balance();
    const result = await Promise.allSettled([
      turns.submit(SEED_USER_ID, SEED_CHAT_ID, 'Find a laptop', randomUUID()),
      turns.submit(SEED_USER_ID, SEED_CHAT_ID, 'Find a phone', randomUUID()),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const grant = await ctx.prisma.aiCreditGrant.findFirstOrThrow({
      where: { userId: SEED_USER_ID },
    });
    expect(grant).toMatchObject({ remaining: 0, reserved: 1 });
  });
  it('reuses a request identity, charges once, and blocks the next message', async () => {
    await balance();
    const key = randomUUID();
    const first = await turns.submit(SEED_USER_ID, SEED_CHAT_ID, 'Find a laptop', key);
    const again = await turns.submit(SEED_USER_ID, SEED_CHAT_ID, 'Find a laptop', key);
    expect(again.turn.id).toBe(first.turn.id);
    const running = await turns.begin(SEED_USER_ID, SEED_CHAT_ID, first.message.id);
    const reply = await turns.complete(running, content, true);
    expect((await turns.complete(running, content, true)).id).toBe(reply.id);
    expect(await ctx.prisma.aiCreditEntry.count({ where: { kind: 'CONSUME' } })).toBe(1);
    await expect(turns.submit(SEED_USER_ID, SEED_CHAT_ID, 'Find a phone')).rejects.toMatchObject({
      status: 402,
    });
    expect((await turns.status(SEED_USER_ID, SEED_CHAT_ID, first.turn.id)).reply?.id).toBe(
      reply.id,
    );
  });
  it('releases a failed attempt and allows a retry without duplicating the user message', async () => {
    await balance();
    const first = await turns.submit(SEED_USER_ID, SEED_CHAT_ID, 'Find headphones');
    const running = await turns.begin(SEED_USER_ID, SEED_CHAT_ID, first.message.id);
    await turns.fail(running);
    const retry = await turns.begin(SEED_USER_ID, SEED_CHAT_ID, first.message.id);
    expect(retry.attempt).toBe(2);
    await expect(turns.complete(running, content, true)).rejects.toThrow('expired');
    await turns.complete(retry, content, true);
    expect(await ctx.prisma.message.count({ where: { id: first.message.id } })).toBe(1);
  });
  it('uses plan, then welcome, then purchased credits and preserves paid balances', async () => {
    await balance(1, 1, 1, new Date(Date.now() + 86_400_000));
    const sources = [];
    for (let n = 0; n < 3; n++) {
      const submitted = await turns.submit(SEED_USER_ID, SEED_CHAT_ID, `Find item ${n}`);
      const running = await turns.begin(SEED_USER_ID, SEED_CHAT_ID, submitted.message.id);
      sources.push(
        (await ctx.prisma.aiCreditGrant.findUniqueOrThrow({ where: { id: running.grantId! } }))
          .source,
      );
      await turns.complete(running, content, true);
    }
    expect(sources).toEqual(['PLAN', 'WELCOME', 'PURCHASED']);
  });
  it('finishes a reservation made before expiry and never resurrects an expired released credit', async () => {
    await balance(0, 2, 1, new Date(Date.now() + 86_400_000));
    const submitted = await turns.submit(SEED_USER_ID, SEED_CHAT_ID, 'Find item');
    const running = await turns.begin(SEED_USER_ID, SEED_CHAT_ID, submitted.message.id);
    await ctx.prisma.aiCreditGrant.update({
      where: { id: running.grantId! },
      data: { expiresAt: new Date(0) },
    });
    await turns.complete(running, content, true);
    const summary = await ctx.app.get(BillingService).summary(SEED_USER_ID);
    expect(summary.credits).toMatchObject({ plan: 0, purchased: 1, spendable: 1 });
    const next = await turns.submit(SEED_USER_ID, SEED_CHAT_ID, 'Find another item');
    expect(
      (await ctx.prisma.aiCreditGrant.findUniqueOrThrow({ where: { id: next.turn.grantId! } }))
        .source,
    ).toBe('PURCHASED');
  });
  it('releases expired held plan credits without making them spendable', async () => {
    await balance(0, 1, 0, new Date(Date.now() + 86_400_000));
    const submitted = await turns.submit(SEED_USER_ID, SEED_CHAT_ID, 'Find item');
    const running = await turns.begin(SEED_USER_ID, SEED_CHAT_ID, submitted.message.id);
    await ctx.prisma.aiCreditGrant.update({
      where: { id: running.grantId! },
      data: { expiresAt: new Date(0) },
    });
    await turns.fail(running);
    expect((await ctx.app.get(BillingService).summary(SEED_USER_ID)).credits.total).toBe(0);
    expect(await ctx.prisma.aiCreditEntry.count({ where: { kind: 'RELEASE_EXPIRED' } })).toBe(1);
  });
  it('releases off-topic replies, recovers abandoned reservations, and enforces ownership', async () => {
    await balance();
    const submitted = await turns.submit(SEED_USER_ID, SEED_CHAT_ID, 'Tell me a joke');
    const running = await turns.begin(SEED_USER_ID, SEED_CHAT_ID, submitted.message.id);
    await turns.complete(running, content, false);
    expect((await ctx.app.get(BillingService).summary(SEED_USER_ID)).credits.total).toBe(1);
    const abandoned = await turns.submit(SEED_USER_ID, SEED_CHAT_ID, 'Find item');
    await ctx.prisma.aiChatTurn.update({
      where: { id: abandoned.turn.id },
      data: { leaseUntil: new Date(0) },
    });
    await turns.reap();
    expect((await ctx.app.get(BillingService).summary(SEED_USER_ID)).credits.total).toBe(1);
    await expect(
      turns.status(SEED_OTHER_ID, SEED_CHAT_ID, submitted.turn.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(turns.submit(SEED_OTHER_ID, SEED_CHAT_ID, 'Find item')).rejects.toMatchObject({
      status: 404,
    });
  });
  it('enforces credit exhaustion on both legacy and new HTTP endpoints', async () => {
    await balance(0);
    const legacy = await ctx.http
      .post(`/chats/${SEED_CHAT_ID}/messages`)
      .send({ content: 'Find headphones' })
      .expect(402);
    expect(legacy.body.code).toBe('AI_CREDITS_REQUIRED');
    const canonical = await ctx.http
      .post(`/chats/${SEED_CHAT_ID}/turns`)
      .send({ content: 'Find headphones', requestKey: randomUUID() })
      .expect(402);
    expect(canonical.body.code).toBe('AI_CREDITS_REQUIRED');
    expect(await ctx.prisma.aiChatTurn.count()).toBe(0);
  });
  it('new confirmed grants restore eligibility without another welcome grant', async () => {
    await balance(0);
    await ctx.prisma.$transaction(async (tx) => {
      const credits = ctx.app.get(AiCreditsService);
      await credits.lock(tx, SEED_USER_ID);
      await credits.initialize(tx, SEED_USER_ID);
      await credits.add(tx, SEED_USER_ID, 'PURCHASED', 'test-confirmed-order', 10);
      await credits.add(tx, SEED_USER_ID, 'PURCHASED', 'test-confirmed-order', 10);
    });
    expect((await ctx.app.get(BillingService).summary(SEED_USER_ID)).credits).toMatchObject({
      purchased: 10,
      welcome: 0,
      canChat: true,
    });
  });
});
