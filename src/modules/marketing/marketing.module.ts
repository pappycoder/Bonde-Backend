import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit/audit-log.module.js';
import { MarketingPublicController } from './marketing.controller.js';
import { MarketingService } from './marketing.service.js';

/**
 * Public marketing write surface (waitlist + contact) for the Bonde website.
 * Reads for the admin console come from the generic CRUD registry
 * (`GET /api/admin/waitlist`, `GET /api/admin/contacts`), so no admin
 * controller lives here.
 */
@Module({
  imports: [AuditLogModule],
  controllers: [MarketingPublicController],
  providers: [MarketingService],
})
export class MarketingModule {}
