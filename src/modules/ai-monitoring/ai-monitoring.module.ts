import { Global, Module } from '@nestjs/common';
import { AiMonitoringController } from './ai-monitoring.controller.js';
import { AiMonitoringService } from './ai-monitoring.service.js';
import { AiUsageService } from './ai-usage.service.js';

@Global()
@Module({
  controllers: [AiMonitoringController],
  providers: [AiUsageService, AiMonitoringService],
  exports: [AiUsageService, AiMonitoringService],
})
export class AiMonitoringModule {}
