import { Controller, Get, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ServicePurchases } from '../finance/service-purchases.service.js';
import { secretMatches } from '../finance/finance.types.js';
import { ChatTurnsService } from './chat-turns.service.js';
import { ChatWorker } from './chat-worker.service.js';
import { AiMonitoringService } from '../ai-monitoring/ai-monitoring.service.js';

@ApiTags('shopping-operations')
@Controller('shopping')
export class ShoppingJobsController {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly worker: ChatWorker,
    private readonly turns: ChatTurnsService,
    private readonly services: ServicePurchases,
    private readonly prisma: PrismaService,
    private readonly monitoring: AiMonitoringService,
  ) {}
  @Post('jobs')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Run durable shopping jobs using the configured job bearer token' })
  async run(@Headers('authorization') authorization?: string) {
    const token = this.config.get('finance', { infer: true }).jobToken;
    if (!token || !secretMatches(authorization, `Bearer ${token}`))
      throw new UnauthorizedException();
    await this.turns.reap();
    await this.worker.run();
    await this.services.run();
    await this.monitoring.run();
    return { processed: true };
  }
  @Get('operations')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Inspect usage counters and pending reconciliation age' })
  async operations() {
    const [turns, latest, orders, oldest] = await Promise.all([
      this.prisma.aiChatTurn.groupBy({ by: ['status'], _count: true }),
      this.prisma.aiChatTurn.findMany({
        take: 100,
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, usage: true, createdAt: true },
      }),
      this.prisma.serviceOrder.groupBy({ by: ['status'], _count: true }),
      this.prisma.serviceOrder.findFirst({
        where: { status: { in: ['PENDING', 'PROCESSING'] } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, createdAt: true },
      }),
    ]);
    return {
      turns,
      recentUsage: latest,
      orders,
      oldestPending: oldest,
      supplierBalance: await this.prisma.supplierBalanceSnapshot.findFirst({
        where: { provider: 'SAFE_HAVEN' },
        orderBy: { observedAt: 'desc' },
      }),
    };
  }
}
