import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { ActivityModule } from '../activity/activity.module.js';
import { DojahKycClient } from './dojah.client.js';
import { KycController } from './kyc.controller.js';
import { KycService } from './kyc.service.js';
import { KYC_PROVIDER } from './kyc.types.js';

/**
 * Identity verification (BVN/NIN). Owns the provider client under the
 * `KYC_PROVIDER` token so e2e swaps it for a fake; feature code injects the
 * token, never a concrete client.
 */
@Module({
  imports: [ActivityModule],
  controllers: [KycController],
  providers: [
    {
      provide: KYC_PROVIDER,
      useFactory: (config: ConfigService<AppConfig, true>) =>
        new DojahKycClient(config.get('dojah')),
      inject: [ConfigService],
    },
    KycService,
  ],
  exports: [KycService],
})
export class KycModule {}
