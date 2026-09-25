import { Module } from '@nestjs/common';
import { AdminConsoleController } from './admin-console.controller.js';
import { AdminConsoleTransactionsService } from './admin-console-transactions.service.js';
import { AdminConsoleUsersService } from './admin-console-users.service.js';

/**
 * Read-only admin console over the ledger + profiles/accounts/wallets (the
 * tables excluded from the generic `crud` registry). Must stay imported BEFORE
 * `CrudModule` so the literal `/admin/users` / `/admin/transactions` routes are
 * matched before the generic `/admin/:resource[/:id]` routes.
 */
@Module({
  controllers: [AdminConsoleController],
  providers: [AdminConsoleUsersService, AdminConsoleTransactionsService],
})
export class AdminConsoleModule {}
