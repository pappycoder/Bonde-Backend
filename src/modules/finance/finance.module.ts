import { FinanceInstallation } from './finance-installation.service.js';
import { FinanceReconciliation } from './finance-reconciliation.service.js';
import { AuditLogModule } from '../audit/audit-log.module.js';
import { Global, Module } from '@nestjs/common';
import { PasscodeModule } from '../passcode/passcode.module.js';
import { FinanceService } from './finance.service.js';
import { LedgerService } from './ledger.service.js';
import { FinanceCapabilities } from './finance-capabilities.service.js';
import { FinanceIdentityService } from './finance-identity.service.js';
import { FinanceWorker } from './finance-worker.service.js';
import { FinanceAuthorizations } from './finance-authorizations.service.js';
import { FinanceEvents } from './finance-events.service.js';
import {
  FinanceController,
  FinanceWebhooksController,
  AdminFinanceController,
} from './finance.controller.js';
import { SafeHavenClient, SudoClient } from './providers.js';

@Global()
@Module({
  imports: [PasscodeModule, AuditLogModule],
  controllers: [FinanceController, FinanceWebhooksController, AdminFinanceController],
  providers: [
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
  exports: [FinanceService, FinanceCapabilities, SafeHavenClient, SudoClient],
})
export class FinanceModule {}
