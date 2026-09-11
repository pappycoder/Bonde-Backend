import { Module } from '@nestjs/common';
import { BiometricsController } from './biometrics.controller.js';
import { BiometricsService } from './biometrics.service.js';
import { ActivityModule } from '../activity/activity.module.js';

@Module({
  imports: [ActivityModule],
  controllers: [BiometricsController],
  providers: [BiometricsService],
  exports: [BiometricsService],
})
export class BiometricsModule {}
