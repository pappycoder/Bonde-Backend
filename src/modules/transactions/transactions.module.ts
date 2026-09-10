import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit/audit-log.module.js';
import { ApprovalsController } from './approvals.controller.js';
import { ApprovalsService } from './approvals.service.js';
import { TransactionsController } from './transactions.controller.js';
import { TransactionsService } from './transactions.service.js';

@Module({
  imports: [AuditLogModule],
  controllers: [TransactionsController, ApprovalsController],
  providers: [TransactionsService, ApprovalsService],
  exports: [TransactionsService, ApprovalsService],
})
export class TransactionsModule {}
