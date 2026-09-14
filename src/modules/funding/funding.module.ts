import { Module } from '@nestjs/common';
import { FlutterwaveModule } from '../flutterwave/flutterwave.module.js';
import { ActivityModule } from '../activity/activity.module.js';
import { FlutterwaveWebhookController } from './flutterwave-webhook.controller.js';
import { FundingController } from './funding.controller.js';
import { VirtualAccountsService } from './virtual-accounts.service.js';
import { DepositsService } from './deposits.service.js';
import { WithdrawalsService } from './withdrawals.service.js';

/**
 * Wallet funding + payout orchestration built on the reusable Flutterwave
 * package. Credits (`charge.completed`) and transfer statuses
 * (`transfer.disburse`/`transfer.reversal`) are applied idempotently via the
 * `provider_events` sink.
 */
@Module({
  imports: [FlutterwaveModule, ActivityModule],
  controllers: [FlutterwaveWebhookController, FundingController],
  providers: [VirtualAccountsService, DepositsService, WithdrawalsService],
  exports: [DepositsService, WithdrawalsService],
})
export class FundingModule {}
