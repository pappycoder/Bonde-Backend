import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MAIL_SENDER, type MailMessage } from '../src/common/mail/mail.types.js';
import { AiMonitoringService } from '../src/modules/ai-monitoring/ai-monitoring.service.js';
import { AiUsageService } from '../src/modules/ai-monitoring/ai-usage.service.js';
import { AiCreditsService } from '../src/modules/billing/ai-credits.service.js';
import { ConfigService } from '@nestjs/config';
import {
  bootE2EApp,
  seedBaseFixtures,
  truncateAll,
  SEED_CHAT_ID,
  SEED_USER_ID,
  type BootedE2EApp,
} from './e2e-app.js';

describe('Admin AI monitoring and funding alerts (e2e)', () => {
  let ctx: BootedE2EApp;
  let monitor: AiMonitoringService;
  let meter: AiUsageService;
  const sent: MailMessage[] = [];
  let failMail = false;
  const failRecipients = new Set<string>();
  const call = (tokens: number, model = 'test-model') =>
    meter.fetch(
      'OPENAI',
      { userId: SEED_USER_ID, chatId: SEED_CHAT_ID, model },
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',
        body: 'private prompt not retained',
        headers: { Authorization: 'Bearer secret-not-retained' },
      },
    );
  const respond = (input: number, output = 0, cached = 0, reasoning = 0) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              usage: {
                input_tokens: input,
                input_tokens_details: { cached_tokens: cached },
                output_tokens: output,
                output_tokens_details: { reasoning_tokens: reasoning },
              },
            }),
          ),
      ),
    );
  async function rate(input = '1', cached = '0', output = '0') {
    return monitor.rate(SEED_USER_ID, {
      provider: 'OPENAI',
      model: 'test-model',
      inputPerMillion: input,
      cachedInputPerMillion: cached,
      outputPerMillion: output,
      searchPerThousand: '0',
    });
  }
  async function funding(amount = '1', reference = randomUUID()) {
    return monitor.funding(SEED_USER_ID, {
      provider: 'OPENAI',
      amountUsd: amount,
      reference,
      note: 'Test funding; no payment',
    });
  }
  beforeAll(async () => {
    ctx = await bootE2EApp({
      overrides: [
        {
          token: MAIL_SENDER,
          useValue: {
            send: async (message: MailMessage) => {
              if (failMail || failRecipients.has(message.to))
                throw new Error('Simulated mail failure');
              sent.push(message);
            },
          },
        },
      ],
    });
    monitor = ctx.app.get(AiMonitoringService);
    ctx.app.get(ConfigService).set('aiMonitoring', { enabled: true });
    monitor.onModuleDestroy();
    meter = ctx.app.get(AiUsageService);
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
    sent.length = 0;
    failMail = false;
    failRecipients.clear();
    ctx.role('ADMIN');
    ctx.app.get(ConfigService).set('aiMonitoring', { enabled: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps reporting and alert jobs inactive while deployment is pending', async () => {
    ctx.app.get(ConfigService).set('aiMonitoring', { enabled: false });
    await ctx.http.get('/admin/ai-usage').expect(503);
    expect(await monitor.run()).toEqual({ processed: false });
    expect(await ctx.prisma.aiUsageAlert.count()).toBe(0);
  });

  it('restricts monitoring to administrators and validates periods and thresholds', async () => {
    ctx.role('USER');
    await ctx.http.get('/admin/ai-usage').expect(403);
    await ctx.http.post('/admin/ai-usage/check').send({}).expect(403);
    ctx.role('ADMIN');
    await ctx.http.get('/admin/ai-usage?days=91').expect(400);
    await ctx.http
      .put('/admin/ai-usage/settings')
      .send({ provider: 'OPENAI', warningPercent: 10, criticalPercent: 20, emailRecipients: [] })
      .expect(400);
    await ctx.http.get('/admin/ai-usage').expect(200);
    const fresh = await ctx.http.get(`/admin/ai-usage?userId=${SEED_USER_ID}`).expect(200);
    expect(fresh.body.users.items[0]).toMatchObject({
      id: SEED_USER_ID,
      creditsRemaining: null,
      creditsConsumed: 0,
    });
  });
  it('preserves every request, prices token subsets once and exposes user credits separately', async () => {
    await rate('2', '0.5', '8');
    await funding();
    respond(100, 25, 40, 10);
    await call(100);
    await ctx.prisma.$transaction(async (tx) => {
      const credits = ctx.app.get(AiCreditsService);
      await credits.lock(tx, SEED_USER_ID);
      const grant = await credits.reserve(tx, SEED_USER_ID, 'monitoring-test');
      await credits.finish(tx, SEED_USER_ID, grant, 'monitoring-test', true);
    });
    const result = await ctx.http.get('/admin/ai-usage?days=1').expect(200);
    expect(result.body.totals).toMatchObject({
      requests: 1,
      inputTokens: 100,
      outputTokens: 25,
      cachedInputTokens: 40,
      reasoningTokens: 10,
      unknownCostRequests: 0,
    });
    expect(Number(result.body.totals.estimatedCostUsd)).toBeCloseTo(0.00034, 10);
    expect(result.body.users.items[0]).toMatchObject({
      id: SEED_USER_ID,
      creditsConsumed: 1,
      creditsRemaining: 9,
    });
    expect(result.body.credits.issuedRemaining).toBe(9);
    expect(result.body.credits.consumedPeriod).toBe(1);
    expect(Number(result.body.providers[0].estimatedRemainingUsd)).toBeCloseTo(0.99966, 10);
    expect(JSON.stringify(result.body)).not.toContain('secret-not-retained');
    expect(JSON.stringify(result.body)).not.toContain('private prompt');
    expect((await ctx.prisma.aiUsageEvent.findMany())[0].rateId).toBeTruthy();
  });
  it('does not rewrite unpriced receipts when prices are configured later, and retains failures', async () => {
    await funding();
    respond(1000);
    await call(1000);
    await rate();
    await call(1000);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    await expect(call(1)).rejects.toThrow('timeout');
    const result = await ctx.http.get('/admin/ai-usage').expect(200);
    expect(result.body.totals).toMatchObject({
      requests: 3,
      unknownCostRequests: 2,
      failedRequests: 1,
    });
    expect(result.body.providers[0].estimatedRunwayDays).toBeNull();
    expect(await ctx.prisma.aiUsageEvent.count()).toBe(3);
    const first = await ctx.prisma.aiUsageEvent.findFirstOrThrow({
      orderBy: { occurredAt: 'asc' },
    });
    expect(first.costUsd).toBeNull();
    await expect(
      ctx.prisma.aiUsageEvent.update({ where: { id: first.id }, data: { costUsd: '1' } }),
    ).rejects.toThrow('immutable');
  });
  it('records concurrent funding retries once and ignores usage before the opening balance', async () => {
    await rate();
    respond(1000000);
    await call(1000000);
    const reference = randomUUID();
    const results = await Promise.all([funding('10', reference), funding('10', reference)]);
    expect(results[0].id).toBe(results[1].id);
    expect(await ctx.prisma.aiProviderFunding.count()).toBe(1);
    expect(Number((await monitor.provider('OPENAI')).estimatedRemainingUsd)).toBe(10);
    await expect(funding('20', reference)).rejects.toThrow('different details');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ai.monitoring.funding' } })).toBe(1);
  });

  it('reconciles an observed balance without deleting old usage or funding history', async () => {
    await funding('10');
    respond(1000);
    await call(1000);
    expect((await monitor.provider('OPENAI')).unknownCostRequests).toBe(1);
    await monitor.funding(SEED_USER_ID, {
      provider: 'OPENAI',
      amountUsd: '7',
      reference: randomUUID(),
      note: 'Balance checked at provider',
      operation: 'BALANCE',
    });
    const snapshot = await monitor.provider('OPENAI');
    expect(snapshot.unknownCostRequests).toBe(0);
    expect(Number(snapshot.estimatedRemainingUsd)).toBe(7);
    expect(await ctx.prisma.aiUsageEvent.count()).toBe(1);
    expect(await ctx.prisma.aiProviderFunding.count()).toBe(2);
  });

  it('projects legacy allowances and preserves reservations on expired grants', async () => {
    await ctx.prisma.aiCreditAccount.create({
      data: {
        userId: SEED_USER_ID,
        welcomeRemaining: 100,
        planRemaining: 20,
        purchasedRemaining: 5,
      },
    });
    let result = await ctx.http.get('/admin/ai-usage').expect(200);
    expect(result.body.credits.issuedRemaining).toBe(125);
    expect(result.body.users.items[0].creditsRemaining).toBe(125);
    await ctx.prisma.aiCreditAccount.update({
      where: { userId: SEED_USER_ID },
      data: { ledgerInitialized: true },
    });
    await ctx.prisma.aiCreditGrant.create({
      data: {
        id: randomUUID(),
        userId: SEED_USER_ID,
        source: 'PLAN',
        sourceKey: 'expired-reservation',
        units: 10,
        remaining: 9,
        reserved: 1,
        expiresAt: new Date(Date.now() - 86400000),
      },
    });
    result = await ctx.http.get('/admin/ai-usage').expect(200);
    expect(result.body.credits).toMatchObject({ issuedRemaining: 0, reserved: 1 });
    expect(result.body.users.items[0]).toMatchObject({
      creditsRemaining: 0,
      creditsReserved: 1,
      creditsConsumed: 0,
    });
  });

  it('uses a shared delivery lease and does not resend recipients who already received an alert', async () => {
    await rate();
    await monitor.settings(SEED_USER_ID, {
      provider: 'OPENAI',
      warningPercent: 20,
      criticalPercent: 10,
      emailRecipients: ['good@example.com', 'retry@example.com'],
    });
    await funding();
    respond(1000000);
    await call(1000000);
    failRecipients.add('retry@example.com');
    const otherWorker = new AiMonitoringService(
      ctx.prisma,
      ctx.app.get(ConfigService),
      ctx.app.get(MAIL_SENDER),
    );
    await Promise.all([monitor.run(), otherWorker.run()]);
    expect(sent.map((message) => message.to)).toEqual(['good@example.com']);
    const alert = await ctx.prisma.aiUsageAlert.findFirstOrThrow();
    expect(alert.sentTo).toEqual(['good@example.com']);
    failRecipients.clear();
    await ctx.prisma.aiUsageAlert.update({
      where: { id: alert.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await monitor.run();
    expect(sent.map((message) => message.to)).toEqual(['good@example.com', 'retry@example.com']);
  });
  it('deduplicates threshold alerts, retries only unsent email and rearms after replenishment', async () => {
    await rate();
    await monitor.settings(SEED_USER_ID, {
      provider: 'OPENAI',
      warningPercent: 20,
      criticalPercent: 10,
      emailRecipients: ['admin@example.com'],
    });
    await funding();
    respond(1000000);
    await call(1000000);
    failMail = true;
    await monitor.run();
    expect(await ctx.prisma.aiUsageAlert.count()).toBe(1);
    const alert = await ctx.prisma.aiUsageAlert.findFirstOrThrow();
    expect(alert).toMatchObject({ severity: 'CRITICAL', emailComplete: false, emailAttempts: 1 });
    failMail = false;
    await ctx.prisma.aiUsageAlert.update({
      where: { id: alert.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await monitor.run();
    await monitor.run();
    expect(sent).toHaveLength(1);
    expect(
      (await ctx.prisma.aiUsageAlert.findUniqueOrThrow({ where: { id: alert.id } })).emailComplete,
    ).toBe(true);
    await funding('5');
    expect(
      (await ctx.prisma.aiUsageAlert.findUniqueOrThrow({ where: { id: alert.id } })).resolvedAt,
    ).not.toBeNull();
    respond(4100000);
    await call(4100000);
    await monitor.run();
    expect(sent).toHaveLength(2);
    expect(
      await ctx.prisma.aiUsageAlert.count({ where: { severity: 'WARNING', resolvedAt: null } }),
    ).toBe(1);
  });
});
