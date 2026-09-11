import { Module } from '@nestjs/common';
import { ThresholdsController } from './thresholds.controller.js';
import { ThresholdsService } from './thresholds.service.js';
import { ActivityModule } from '../activity/activity.module.js';

@Module({
  imports: [ActivityModule],
  controllers: [ThresholdsController],
  providers: [ThresholdsService],
  exports: [ThresholdsService],
})
export class ThresholdsModule {}
