import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { estimateCost, usageCounts, type AiProvider } from './usage-math.js';

@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async fetch(
    provider: AiProvider,
    context: { userId: string; chatId: string; model: string },
    url: string | URL,
    init: RequestInit,
  ) {
    if (!this.config.get('aiMonitoring', { infer: true }).enabled) return fetch(url, init);
    const started = Date.now();
    const id = randomUUID();
    // Persist intent before leaving the server. A killed process leaves a visible
    // PENDING/unknown-cost observation rather than silently losing provider spend.
    await this.prisma.aiUsageEvent.create({
      data: {
        id,
        ...context,
        provider,
        status: 'PENDING',
        durationMs: 0,
        occurredAt: new Date(started),
      },
    });
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      await this.prisma.aiUsageEvent
        .update({
          where: { id },
          data: {
            status: 'UNKNOWN',
            durationMs: Math.min(Date.now() - started, 2147483647),
          },
        })
        .catch(() =>
          this.logger.error(
            'Could not finalize AI request observation; pending usage requires review.',
          ),
        );
      throw error;
    }
    try {
      const body: unknown =
        provider === 'OPENAI'
          ? await response
              .clone()
              .json()
              .catch(() => null)
          : null;
      const counts = usageCounts(body);
      const status = response.ok ? 'SUCCESS' : 'HTTP_ERROR';
      const rate = await this.prisma.aiUsageRate.findFirst({
        where: { provider, model: context.model, createdAt: { lte: new Date(started) } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      await this.prisma.aiUsageEvent.update({
        where: { id },
        data: {
          status,
          httpStatus: response.status,
          ...counts,
          durationMs: Math.min(Date.now() - started, 2147483647),
          rateId: rate?.id,
          costUsd: estimateCost(provider, status, counts, rate),
        },
      });
    } catch {
      // Never repeat a paid call because recording its receipt failed. The
      // original PENDING row remains explicit in the dashboard's unknown costs.
      this.logger.error(
        'Could not finalize AI request observation; pending usage requires review.',
      );
    }
    return response;
  }
}
