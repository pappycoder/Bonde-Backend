import { Module } from '@nestjs/common';
import { PasscodeController } from './passcode.controller.js';
import { PasscodeService } from './passcode.service.js';
import { ActivityModule } from '../activity/activity.module.js';

@Module({
  imports: [ActivityModule],
  controllers: [PasscodeController],
  providers: [PasscodeService],
  exports: [PasscodeService],
})
export class PasscodeModule {}
