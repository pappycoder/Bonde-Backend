import { Module } from '@nestjs/common';
import { CrudController } from './crud.controller.js';
import { CrudService } from './crud.service.js';
import { AuditLogModule } from '../audit/audit-log.module.js';

/**
 * Generic admin CRUD over the SAFE registry tables (see `crud.registry.ts`).
 * Writes are audit-logged; append-only tables expose read only.
 */
@Module({
  imports: [AuditLogModule],
  controllers: [CrudController],
  providers: [CrudService],
})
export class CrudModule {}
