import { BillingRenewalService } from './billing-renewal.service.js';
import { AiCreditsModule } from './ai-credits.module.js';
import { Module } from '@nestjs/common';
import { PasscodeModule } from '../passcode/passcode.module.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
@Module({
  imports: [PasscodeModule, AiCreditsModule],
  controllers: [BillingController],
  providers: [BillingService, BillingRenewalService],
  exports: [BillingService],
})
export class BillingModule {}
