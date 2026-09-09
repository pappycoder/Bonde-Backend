import { Controller, Get, HttpCode, HttpStatus, Inject } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthIndicatorService } from '@nestjs/terminus';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';
import type { RedisClient } from '../common/redis/redis-client.interface.js';
import { Public } from '../auth/public.decorator.js';
import { ApiErrorResponse } from '../common/api-error-response.decorator.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  @Get()
  @Public()
  @HealthCheck()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Live health check (dependencies up/down)' })
  @ApiOkResponse({ description: 'Health of backing services (e.g. Redis)' })
  @ApiErrorResponse()
  check() {
    return this.health.check([
      () =>
        this.indicator.check('redis').attempt(async (_signal) => {
          const pong = await this.redis.ping();
          if (pong !== 'PONG') throw new Error('unexpected PING response');
          return { message: 'pong' };
        }),
    ]);
  }

  @Get('ready')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Readiness probe (app accepts traffic)' })
  @ApiOkResponse({ description: '`{ status: "ready" }`' })
  readiness() {
    return { status: 'ready' as const };
  }
}
