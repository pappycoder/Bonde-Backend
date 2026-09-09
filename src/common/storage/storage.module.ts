import { Global, Module } from '@nestjs/common';
import { StorageController } from './storage.controller.js';
import { StorageService } from './storage.service.js';

/**
 * Global Supabase Storage client. Bridges `SUPABASE_URL` + the service-role
 * key (typed config) to the Storage REST API and owns all object-path/content
 * guardrails. Any feature module can inject `StorageService` without importing
 * this module explicitly.
 */
@Global()
@Module({
  controllers: [StorageController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
