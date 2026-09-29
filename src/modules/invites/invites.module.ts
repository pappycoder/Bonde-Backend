import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit/audit-log.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { InvitesController, InvitesPublicController } from './invites.controller.js';
import { InvitesService } from './invites.service.js';

@Module({
  // UserProvisioningService is exported by AuthModule: acceptance provisions
  // the account + wallet exactly the way email verification does.
  imports: [AuthModule, AuditLogModule],
  controllers: [InvitesController, InvitesPublicController],
  providers: [InvitesService],
  exports: [InvitesService],
})
export class InvitesModule {}
