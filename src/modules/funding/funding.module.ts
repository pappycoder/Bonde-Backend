import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { BankAccountsService } from './bank-accounts.service.js';
import { FundingController } from './funding.controller.js';
import { WalletInsightsService } from './wallet-insights.service.js';

/** Recipient management and budget metadata. Money movement belongs to FinanceModule. */
@Module({
  imports: [ActivityModule],
  controllers: [FundingController],
  providers: [WalletInsightsService, BankAccountsService],
})
export class FundingModule {}
