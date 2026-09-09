import { Module, Global } from '@nestjs/common';
import { CacheService } from './cache.service.js';

/**
 * Global cache infrastructure on top of the shared Redis client.
 *
 * Exposes `CacheService` app-wide; feature modules inject it for cache-aside
 * reads/writes without wiring their own Redis access.
 */
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
