import { Module } from '@nestjs/common';
import { CardsController } from './cards.controller.js';
import { CardsService } from './cards.service.js';
import { AuditLogModule } from '../audit/audit-log.module.js';

@Module({
  imports: [AuditLogModule],
  controllers: [CardsController],
  providers: [CardsService],
  exports: [CardsService],
})
export class CardsModule {}
