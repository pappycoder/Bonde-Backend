import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit/audit-log.module.js';
import { WalletsController } from './wallets.controller.js';
import { WalletsService } from './wallets.service.js';

@Module({
  imports: [AuditLogModule],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
