import { Module } from '@nestjs/common';
import { ThresholdsController } from './thresholds.controller.js';
import { ThresholdsService } from './thresholds.service.js';
import { AuditLogModule } from '../audit/audit-log.module.js';

@Module({
  imports: [AuditLogModule],
  controllers: [ThresholdsController],
  providers: [ThresholdsService],
  exports: [ThresholdsService],
})
export class ThresholdsModule {}
