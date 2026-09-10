import { Module } from '@nestjs/common';
import { ProfilesController } from './profiles.controller.js';
import { ProfilesService } from './profiles.service.js';
import { AuditLogModule } from '../audit/audit-log.module.js';

@Module({
  imports: [AuditLogModule],
  controllers: [ProfilesController],
  providers: [ProfilesService],
  exports: [ProfilesService],
})
export class ProfilesModule {}
