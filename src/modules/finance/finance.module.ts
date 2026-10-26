import { FinancePolicy } from './finance-policy.service.js';
import { FinanceRetirement } from './finance-retirement.service.js';
import { FinanceMerchants } from './finance-merchants.service.js';
import { Global, Module } from '@nestjs/common';
import { AuditLogModule } from '../audit/audit-log.module.js';
import { PasscodeModule } from '../passcode/passcode.module.js';
import { FinanceAuthorizations } from './finance-authorizations.service.js';
import { FinanceCapabilities } from './finance-capabilities.service.js';
import { FinanceEvents } from './finance-events.service.js';
import { FinanceIdentityService } from './finance-identity.service.js';
import { FinanceInstallation } from './finance-installation.service.js';
import { FinanceReconciliation } from './finance-reconciliation.service.js';
import { FinanceWorker } from './finance-worker.service.js';
import {
  AdminFinanceController,
  FinanceController,
  FinanceWebhooksController,
} from './finance.controller.js';
import { FinanceService } from './finance.service.js';
import { LedgerService } from './ledger.service.js';
import { SafeHavenClient, SudoClient } from './providers.js';

@Global()
@Module({
  imports: [PasscodeModule, AuditLogModule],
  controllers: [FinanceController, FinanceWebhooksController, AdminFinanceController],
  providers: [
    FinancePolicy,
    FinanceRetirement,
    FinanceMerchants,
    FinanceInstallation,
    FinanceReconciliation,
    FinanceService,
    LedgerService,
    FinanceCapabilities,
    FinanceIdentityService,
    FinanceWorker,
    FinanceAuthorizations,
    FinanceEvents,
    SafeHavenClient,
    SudoClient,
  ],
  exports: [
    FinancePolicy,
    FinanceRetirement,
    FinanceMerchants,
    LedgerService,
    FinanceService,
    FinanceCapabilities,
    SafeHavenClient,
    SudoClient,
  ],
})
export class FinanceModule {}
