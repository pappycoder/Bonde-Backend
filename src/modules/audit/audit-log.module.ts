import { Module } from '@nestjs/common';
import { AuditLogsController } from './audit-logs.controller.js';
import { AuditLogService } from './audit-log.service.js';

/**
 * Provides the append-only AuditLogService plus the self-service surface
 * (`GET /api/audit-logs`, read-only, caller's entries only). Admin-wide
 * listing is served by the generic CRUD surface (`GET /api/admin/audit-logs`).
 */
@Module({
  controllers: [AuditLogsController],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
