import { Module } from '@nestjs/common';
import { AuditLogService } from './audit-log.service.js';

/**
 * Provides the append-only AuditLogService. Listing is served by the generic
 * admin CRUD surface (`GET /api/admin/audit-logs`, read-only).
 */
@Module({
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
