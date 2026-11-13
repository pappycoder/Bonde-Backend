import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { MAIL_SENDER, type MailSender } from '../../common/mail/mail.types.js';
import { emailLayout } from '../../common/mail/templates/layout.js';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  AiFundingDto,
  AiRateDto,
  AiThresholdsDto,
  AiUsageQueryDto,
} from './ai-monitoring.dto.js';
import { AI_PROVIDERS, alertSeverity, type AiProvider } from './usage-math.js';

const zero = () => new Prisma.Decimal(0);
const sum = (value: Prisma.Decimal | null | undefined) => value ?? zero();
const metrics = Prisma.sql`
  count(*)::float8 AS "requests",
  count(*) FILTER (WHERE provider='OPENAI')::float8 AS "modelCalls",
  count(*) FILTER (WHERE provider='BRAVE')::float8 AS "searchAttempts",
  count(*) FILTER (WHERE provider='BRAVE' AND status='SUCCESS')::float8 AS "successfulSearches",
  count(*) FILTER (WHERE status IN ('UNKNOWN','HTTP_ERROR'))::float8 AS "failedRequests",
  count(*) FILTER (WHERE status='PENDING')::float8 AS "pendingRequests",
  count(*) FILTER (WHERE cost_usd IS NULL)::float8 AS "unknownCostRequests",
  coalesce(sum(input_tokens),0)::float8 AS "inputTokens",
  coalesce(sum(cached_input_tokens),0)::float8 AS "cachedInputTokens",
  coalesce(sum(output_tokens),0)::float8 AS "outputTokens",
  coalesce(sum(reasoning_tokens),0)::float8 AS "reasoningTokens",
  coalesce(sum(cost_usd),0)::text AS "estimatedCostUsd"`;
type Metrics = {
  requests: number;
  modelCalls: number;
  searchAttempts: number;
  successfulSearches: number;
  failedRequests: number;
  pendingRequests: number;
  unknownCostRequests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: string;
};

@Injectable()
export class AiMonitoringService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiMonitoringService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  onModuleInit() {
    if (
      this.config.get('nodeEnv') === 'test' ||
      !this.config.get('aiMonitoring', { infer: true }).enabled
    )
      return;
    this.timer = setInterval(
      () =>
        void this.run().catch(() =>
          this.logger.error(
            'AI monitoring job failed; check database migrations and mail delivery.',
          ),
        ),
      60000,
    );
    this.timer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }
  assertEnabled() {
    if (!this.config.get('aiMonitoring', { infer: true }).enabled)
      throw new ServiceUnavailableException(
        'AI monitoring is awaiting activation. Apply its database migration and enable AI_USAGE_MONITORING_ENABLED.',
      );
  }

  private async account(tx: Prisma.TransactionClient, provider: AiProvider) {
    // A client-emulated upsert can race during first-time setup. Native
    // ON CONFLICT serializes concurrent creation before the row lock below.
    await tx.$executeRaw`INSERT INTO ai_provider_accounts (id, provider, cycle_id, updated_at)
      VALUES (${randomUUID()}::uuid, ${provider}, ${randomUUID()}::uuid, ${new Date()}) ON CONFLICT (provider) DO NOTHING`;
  }
  private async lock(tx: Prisma.TransactionClient, provider: AiProvider) {
    await this.account(tx, provider);
    await tx.$queryRaw`SELECT id FROM ai_provider_accounts WHERE provider=${provider} FOR UPDATE`;
    return tx.aiProviderAccount.findUniqueOrThrow({ where: { provider } });
  }
  private async audit(
    tx: Prisma.TransactionClient,
    actor: string,
    action: string,
    id: string,
    metadata: Prisma.InputJsonValue,
  ) {
    await tx.auditLog.create({
      data: {
        id: randomUUID(),
        userId: actor,
        action,
        entityType: 'AI_MONITORING',
        entityId: id,
        metadata,
      },
    });
  }
  async settings(actor: string, input: AiThresholdsDto) {
    this.assertEnabled();
    if (input.criticalPercent >= input.warningPercent)
      throw new BadRequestException('Critical must be lower than warning.');
    const recipients = [
      ...new Set(input.emailRecipients.map((email) => email.trim().toLowerCase())),
    ];
    const result = await this.prisma.$transaction(async (tx) => {
      const account = await this.lock(tx, input.provider);
      const updated = await tx.aiProviderAccount.update({
        where: { provider: input.provider },
        data: {
          warningPercent: input.warningPercent,
          criticalPercent: input.criticalPercent,
          emailRecipients: recipients,
        },
      });
      await tx.aiUsageAlert.updateMany({
        where: { provider: input.provider, resolvedAt: null },
        data: { recipients, emailComplete: recipients.length === 0, nextAttemptAt: new Date() },
      });
      await this.audit(tx, actor, 'ai.monitoring.settings', account.id, {
        provider: input.provider,
        warningPercent: input.warningPercent,
        criticalPercent: input.criticalPercent,
        recipientCount: recipients.length,
      });
      return updated;
    });
    await this.evaluate();
    return result;
  }
  async funding(actor: string, input: AiFundingDto) {
    this.assertEnabled();
    const amount = new Prisma.Decimal(input.amountUsd);
    return this.prisma.$transaction(async (tx) => {
      const account = await this.lock(tx, input.provider);
      const existing = await tx.aiProviderFunding.findUnique({
        where: { reference: input.reference },
      });
      if (existing) {
        if (
          existing.provider !== input.provider ||
          !existing.amountUsd.equals(amount) ||
          existing.note !== input.note ||
          (existing.kind === 'BALANCE' && input.operation !== 'BALANCE') ||
          (existing.kind === 'TOP_UP' && input.operation === 'BALANCE')
        )
          throw new BadRequestException(
            'Funding reference was already used for different details.',
          );
        return existing;
      }
      const reset = !account.baselineAt || input.operation === 'BALANCE';
      if (amount.lt(0) || (!reset && amount.eq(0)))
        throw new BadRequestException('Top-ups must be greater than zero.');
      const observedAt = new Date();
      const [funds, spend] = await Promise.all([
        tx.aiProviderFunding.aggregate({
          where: {
            provider: input.provider,
            ...(account.baselineAt ? { createdAt: { gte: account.baselineAt } } : {}),
          },
          _sum: { amountUsd: true },
        }),
        account.baselineAt
          ? tx.aiUsageEvent.aggregate({
              where: { provider: input.provider, occurredAt: { gte: account.baselineAt } },
              _sum: { costUsd: true },
            })
          : Promise.resolve(null),
      ]);
      const record = await tx.aiProviderFunding.create({
        data: {
          id: randomUUID(),
          provider: input.provider,
          reference: input.reference,
          note: input.note,
          amountUsd: amount,
          kind: !account.baselineAt ? 'OPENING' : reset ? 'BALANCE' : 'TOP_UP',
          createdBy: actor,
          createdAt: observedAt,
        },
      });
      await tx.aiProviderAccount.update({
        where: { provider: input.provider },
        data: {
          baselineAt: reset ? observedAt : account.baselineAt,
          cycleId: record.id,
          thresholdBaseUsd: reset
            ? amount
            : Prisma.Decimal.max(
                0,
                sum(funds._sum.amountUsd).sub(sum(spend?._sum.costUsd)).add(amount),
              ),
        },
      });
      await tx.aiUsageAlert.updateMany({
        where: { provider: input.provider, resolvedAt: null },
        data: { resolvedAt: observedAt },
      });
      await this.audit(tx, actor, 'ai.monitoring.funding', record.id, {
        provider: input.provider,
        amountUsd: amount.toString(),
        kind: record.kind,
      });
      return record;
    });
  }
  async rate(actor: string, input: AiRateDto) {
    this.assertEnabled();
    if (input.provider === 'BRAVE' && input.model !== 'brave-search')
      throw new BadRequestException('Brave model must be brave-search.');
    return this.prisma.$transaction(async (tx) => {
      const record = await tx.aiUsageRate.create({
        data: { id: randomUUID(), ...input, createdBy: actor },
      });
      await this.audit(tx, actor, 'ai.monitoring.pricing', record.id, {
        provider: input.provider,
        model: input.model,
      });
      return record;
    });
  }
  async provider(provider: AiProvider) {
    const account = await this.prisma.aiProviderAccount.findUnique({ where: { provider } });
    const [funds, spend, unknown, recentSpend] = await Promise.all([
      this.prisma.aiProviderFunding.aggregate({
        where: {
          provider,
          ...(account?.baselineAt ? { createdAt: { gte: account.baselineAt } } : {}),
        },
        _sum: { amountUsd: true },
      }),
      account?.baselineAt
        ? this.prisma.aiUsageEvent.aggregate({
            where: { provider, occurredAt: { gte: account.baselineAt } },
            _sum: { costUsd: true },
          })
        : Promise.resolve(null),
      account?.baselineAt
        ? this.prisma.aiUsageEvent.count({
            where: { provider, occurredAt: { gte: account.baselineAt }, costUsd: null },
          })
        : Promise.resolve(0),
      account?.baselineAt
        ? this.prisma.aiUsageEvent.aggregate({
            where: {
              provider,
              occurredAt: {
                gte: new Date(Math.max(account.baselineAt.getTime(), Date.now() - 7 * 86400000)),
              },
            },
            _sum: { costUsd: true },
          })
        : Promise.resolve(null),
    ]);
    const funded = sum(funds._sum.amountUsd);
    const spent = sum(spend?._sum.costUsd);
    const remaining = account?.baselineAt ? funded.sub(spent) : null;
    const measuredDays = account?.baselineAt
      ? Math.max(1 / 24, Math.min(7, (Date.now() - account.baselineAt.getTime()) / 86400000))
      : 0;
    const daily = measuredDays ? sum(recentSpend?._sum.costUsd).div(measuredDays) : zero();
    return {
      provider,
      baselineAt: account?.baselineAt ?? null,
      fundedUsd: funded.toFixed(8),
      spentUsd: spent.toFixed(10),
      estimatedRemainingUsd: remaining?.toFixed(10) ?? null,
      unknownCostRequests: unknown,
      estimatedRunwayDays:
        remaining && remaining.gte(0) && daily.gt(0) && unknown === 0
          ? remaining.div(daily).toDecimalPlaces(1).toNumber()
          : null,
      thresholdBaseUsd: account?.thresholdBaseUsd?.toFixed(10) ?? null,
      warningPercent: account?.warningPercent ?? 20,
      criticalPercent: account?.criticalPercent ?? 10,
      emailRecipients: account?.emailRecipients ?? [],
      severity:
        remaining && account?.thresholdBaseUsd
          ? alertSeverity(
              remaining,
              account.thresholdBaseUsd,
              account.warningPercent,
              account.criticalPercent,
            )
          : null,
      balanceSource: 'ADMIN_FUNDING_ESTIMATE',
      cycleId: account?.cycleId ?? null,
    };
  }
  async overview(query: AiUsageQueryDto) {
    this.assertEnabled();
    const until = new Date();
    const from = new Date(until.getTime() - query.days * 86400000);
    const filter = Prisma.sql`occurred_at >= ${from} AND occurred_at < ${until} ${query.userId ? Prisma.sql`AND user_id=${query.userId}::uuid` : Prisma.empty}`;
    const [
      total,
      byProvider,
      series,
      providers,
      latest,
      alerts,
      rates,
      funding,
      creditTotals,
      creditsUsed,
    ] = await Promise.all([
      this.prisma.$queryRaw<Metrics[]>`SELECT ${metrics} FROM ai_usage_events WHERE ${filter}`,
      this.prisma.$queryRaw<
        Array<Metrics & { provider: string; model: string }>
      >`SELECT provider, model, ${metrics} FROM ai_usage_events WHERE ${filter} GROUP BY provider, model ORDER BY provider, model`,
      this.prisma.$queryRaw<
        Array<Metrics & { bucket: Date }>
      >`SELECT date_trunc(${query.days === 1 ? 'hour' : 'day'}, (occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos' AS bucket, ${metrics} FROM ai_usage_events WHERE ${filter} GROUP BY bucket ORDER BY bucket`,
      Promise.all(AI_PROVIDERS.map((provider) => this.provider(provider))),
      this.prisma.aiUsageEvent.findMany({
        where: {
          occurredAt: { gte: from, lt: until },
          ...(query.userId ? { userId: query.userId } : {}),
        },
        include: { user: { select: { fullName: true, email: true } } },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 30,
      }),
      this.prisma.aiUsageAlert.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
      this.prisma.aiUsageRate.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      }),
      this.prisma.aiProviderFunding.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
      this.prisma.$queryRaw<Array<{ remaining: number; reserved: number }>>`SELECT
          coalesce(sum(CASE WHEN a.ledger_initialized THEN coalesce(g.remaining,0) ELSE a.welcome_remaining+a.purchased_remaining+CASE WHEN a.period_end IS NULL OR a.period_end>${until} THEN a.plan_remaining ELSE 0 END END),0)::float8 AS remaining,
          coalesce(sum(g.reserved),0)::float8 AS reserved
          FROM ai_credit_accounts a LEFT JOIN (
            SELECT user_id, sum(CASE WHEN expires_at IS NULL OR expires_at>${until} THEN remaining ELSE 0 END) AS remaining, sum(reserved) AS reserved FROM ai_credit_grants GROUP BY user_id
          ) g ON a.user_id=g.user_id ${query.userId ? Prisma.sql`WHERE a.user_id=${query.userId}::uuid` : Prisma.empty}`,
      this.prisma.aiCreditEntry.count({
        where: {
          kind: 'CONSUME',
          createdAt: { gte: from, lt: until },
          ...(query.userId ? { userId: query.userId } : {}),
        },
      }),
    ]);
    return {
      from,
      until,
      timezone: 'Africa/Lagos',
      totals: total[0],
      byProvider,
      series,
      providers,
      latest,
      alerts,
      rates,
      funding,
      credits: {
        issuedRemaining: creditTotals[0].remaining,
        reserved: creditTotals[0].reserved,
        consumedPeriod: creditsUsed,
      },
      users: await this.users(query, from, until),
      configuredModel: this.config.get('shopping', { infer: true }).model,
    };
  }
  private async users(query: AiUsageQueryDto, from: Date, until: Date) {
    const cte = Prisma.sql`WITH u AS (
      SELECT user_id, ${metrics} FROM ai_usage_events WHERE occurred_at>=${from} AND occurred_at<${until} GROUP BY user_id
    ), g AS (
      SELECT user_id, sum(CASE WHEN expires_at IS NULL OR expires_at>${until} THEN remaining ELSE 0 END)::float8 AS remaining,
        sum(reserved)::float8 AS reserved FROM ai_credit_grants GROUP BY user_id
    ), c AS (
      SELECT user_id, count(*)::float8 AS consumed FROM ai_credit_entries WHERE kind='CONSUME' AND created_at>=${from} AND created_at<${until} GROUP BY user_id
    )`;
    const joins = Prisma.sql`FROM profiles p LEFT JOIN u ON u.user_id=p.id LEFT JOIN ai_credit_accounts a ON a.user_id=p.id LEFT JOIN g ON g.user_id=p.id LEFT JOIN c ON c.user_id=p.id
      WHERE (u.user_id IS NOT NULL OR a.user_id IS NOT NULL OR ${query.q.length > 0} OR ${!!query.userId})
      AND (p.full_name ILIKE ${'%' + query.q + '%'} OR p.email ILIKE ${'%' + query.q + '%'})
      ${query.userId ? Prisma.sql`AND p.id=${query.userId}::uuid` : Prisma.empty}`;
    const [items, count] = await Promise.all([
      this.prisma.$queryRaw<
        Array<Record<string, unknown>>
      >`${cte} SELECT p.id, p.full_name AS "fullName", p.email, coalesce(u.requests,0)::float8 AS requests,
        coalesce(u."inputTokens",0)::float8 AS "inputTokens", coalesce(u."outputTokens",0)::float8 AS "outputTokens",
        coalesce(u."searchAttempts",0)::float8 AS "searchAttempts", coalesce(u."estimatedCostUsd",'0') AS "estimatedCostUsd",
        coalesce(u."unknownCostRequests",0)::float8 AS "unknownCostRequests", coalesce(c.consumed,0)::float8 AS "creditsConsumed",
        CASE WHEN a.user_id IS NULL THEN NULL WHEN a.ledger_initialized THEN coalesce(g.remaining,0)
          ELSE a.welcome_remaining + a.purchased_remaining + CASE WHEN a.period_end IS NULL OR a.period_end>${until} THEN a.plan_remaining ELSE 0 END END::float8 AS "creditsRemaining",
        coalesce(g.reserved,0)::float8 AS "creditsReserved"
        ${joins} ORDER BY coalesce(u.requests,0) DESC, p.id LIMIT 25 OFFSET ${(query.page - 1) * 25}`,
      this.prisma.$queryRaw<
        Array<{ total: number }>
      >`${cte} SELECT count(*)::float8 AS total ${joins}`,
    ]);
    return {
      items,
      total: count[0].total,
      page: query.page,
      pageSize: 25,
      totalPages: Math.ceil(count[0].total / 25),
    };
  }
  async evaluate() {
    for (const provider of AI_PROVIDERS) {
      const snapshot = await this.provider(provider);
      if (!snapshot.severity || !snapshot.cycleId || snapshot.estimatedRemainingUsd === null)
        continue;
      const cycleId = snapshot.cycleId;
      // Re-check the funding epoch inside a short row lock: replenishment must
      // not race an old low-balance observation into a newly funded cycle.
      await this.prisma.$transaction(async (tx) => {
        const account = await this.lock(tx, provider);
        if (account.cycleId !== cycleId) return;
        await tx.aiUsageAlert.upsert({
          where: { provider_cycleId_severity: { provider, cycleId, severity: snapshot.severity! } },
          update: {},
          create: {
            id: randomUUID(),
            provider,
            cycleId,
            severity: snapshot.severity!,
            remainingUsd: snapshot.estimatedRemainingUsd!,
            recipients: account.emailRecipients,
            emailComplete: account.emailRecipients.length === 0,
          },
        });
      });
    }
  }
  async run() {
    if (!this.config.get('aiMonitoring', { infer: true }).enabled) return { processed: false };
    if (this.running) return { processed: false };
    this.running = true;
    try {
      await this.evaluate();
      const due = await this.prisma.aiUsageAlert.findMany({
        where: {
          emailComplete: false,
          resolvedAt: null,
          nextAttemptAt: { lte: new Date() },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
        },
        take: 10,
        orderBy: { createdAt: 'asc' },
      });
      for (const alert of due) {
        const claim = await this.prisma.aiUsageAlert.updateMany({
          where: {
            id: alert.id,
            emailComplete: false,
            resolvedAt: null,
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
          },
          data: { leaseUntil: new Date(Date.now() + 120000), emailAttempts: { increment: 1 } },
        });
        if (!claim.count) continue;
        let failed = false;
        for (const recipient of alert.recipients.filter((email) => !alert.sentTo.includes(email))) {
          try {
            await this.mail.send({
              to: recipient,
              subject: `Bonde ${alert.severity.toLowerCase()}: ${alert.provider} funding estimate is low`,
              html: emailLayout({
                preheader: 'Review your AI provider funding estimate.',
                headline: 'AI funding needs attention',
                sections: [
                  {
                    kind: 'lead',
                    text: `${alert.provider} reached your ${alert.severity.toLowerCase()} threshold.`,
                  },
                  {
                    kind: 'facts',
                    rows: [
                      {
                        label: 'Estimated remaining',
                        value: `USD ${alert.remainingUsd.toFixed(6)}`,
                      },
                      { label: 'Observed at', value: alert.createdAt.toISOString() },
                    ],
                  },
                  {
                    kind: 'note',
                    text: 'This is an estimate from recorded funding and metered Bonde requests, not a provider-reported balance. Unpriced or uncertain requests may reduce the actual balance further. Review AI usage in the admin dashboard and your provider billing account.',
                  },
                ],
              }),
            });
            await this.prisma.aiUsageAlert.update({
              where: { id: alert.id },
              data: { sentTo: { push: recipient } },
            });
          } catch {
            failed = true;
            this.logger.warn('AI funding alert delivery failed; queued for retry.');
          }
        }
        await this.prisma.aiUsageAlert.update({
          where: { id: alert.id },
          data: {
            emailComplete: !failed,
            leaseUntil: null,
            nextAttemptAt: new Date(
              Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(alert.emailAttempts, 6)),
            ),
          },
        });
      }
      return { processed: true };
    } finally {
      this.running = false;
    }
  }
}
