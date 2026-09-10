import { Module } from '@nestjs/common';
import { BiometricsController } from './biometrics.controller.js';
import { BiometricsService } from './biometrics.service.js';
import { AuditLogModule } from '../audit/audit-log.module.js';

@Module({
  imports: [AuditLogModule],
  controllers: [BiometricsController],
  providers: [BiometricsService],
  exports: [BiometricsService],
})
export class BiometricsModule {}
