import { Controller, Get, HttpCode, HttpStatus, Inject } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthIndicatorService } from '@nestjs/terminus';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';
import type { RedisClient } from '../common/redis/redis-client.interface.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  @Get()
  @HealthCheck()
  @HttpCode(HttpStatus.OK)
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
  @HttpCode(HttpStatus.OK)
  readiness() {
    return { status: 'ready' as const };
  }
}
