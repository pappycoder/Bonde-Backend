import { Module } from '@nestjs/common';
import { CatchAllController } from './catch-all.controller.js';

/**
 * Hosts infrastructure-wide shared controllers (currently the API 404
 * catch-all). Imported LAST in AppModule so its wildcard route never shadows
 * feature routes.
 */
@Module({
  controllers: [CatchAllController],
})
export class CommonModule {}
