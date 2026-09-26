import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit/audit-log.module.js';
import { AdminConsoleController } from './admin-console.controller.js';
import { AdminConsoleStatsService } from './admin-console-stats.service.js';
import { AdminConsoleTransactionsService } from './admin-console-transactions.service.js';
import { AdminConsoleUsersService } from './admin-console-users.service.js';

/**
 * Admin console over the ledger + profiles/accounts/wallets (the tables
 * excluded from the generic `crud` registry). Must stay imported BEFORE
 * `CrudModule` so the literal `/admin/users` / `/admin/transactions` routes are
 * matched before the generic `/admin/:resource[/:id]` routes.
 */
@Module({
  imports: [AuditLogModule],
  controllers: [AdminConsoleController],
  providers: [AdminConsoleUsersService, AdminConsoleTransactionsService, AdminConsoleStatsService],
})
export class AdminConsoleModule {}
