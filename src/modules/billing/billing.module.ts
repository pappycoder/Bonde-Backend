import { BillingRenewalService } from './billing-renewal.service.js';
import { Module } from '@nestjs/common';
import { PasscodeModule } from '../passcode/passcode.module.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
@Module({
  imports: [PasscodeModule],
  controllers: [BillingController],
  providers: [BillingService, BillingRenewalService],
})
export class BillingModule {}
