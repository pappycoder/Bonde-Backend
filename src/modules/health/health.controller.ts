import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthIndicatorService } from '@nestjs/terminus';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { REDIS_CLIENT } from '../../common/redis/redis.module.js';
import type { RedisClient } from '../../common/redis/redis-client.interface.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';

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
    return this.health
      .check([
        () =>
          (async () => {
            const pong = await this.redis.ping();
            if (pong !== 'PONG') throw new Error('unexpected PING response');
            return this.indicator.check('redis').up({ message: 'pong' });
          })(),
      ])
      .catch((error: unknown) => {
        // A down dependency has two shapes: Terminus' ServiceUnavailableException
        // (carrying *which* check failed) or the raw client error when the
        // connection dies at the socket level (ioredis MaxRetriesPerRequestError).
        // Both are "degraded", so both surface as the uniform 503 — a dead
        // Redis must never read as a 500.
        const failures =
          error instanceof ServiceUnavailableException
            ? Object.values(
                (error.getResponse() as { error?: Record<string, string> }).error ?? {},
              ).filter(Boolean)
            : [];
        throw new ServiceUnavailableException({
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          error: 'ServiceUnavailableException',
          message: failures.length > 0 ? failures : ['A backing service is unavailable'],
        });
      });
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
