import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { FLUTTERWAVE_CLIENT, FlutterwaveClient } from './flutterwave.client.js';
import {
  AesGcmCardCredentialEncryptor,
  CardCredentialEncryptor,
} from './flutterwave-credential-crypto.js';
import { FlutterwaveCardsService } from './flutterwave-cards.service.js';

/**
 * Reusable Flutterwave provider package. Owns the low-level client (bearer
 * auth, 10s timeout), the card-domain logic (`FlutterwaveCardsService`), and
 * the credential encryptor. Feature modules inject either the client token
 * (`FLUTTERWAVE_CLIENT`) or the card service and do NOT talk to Flutterwave
 * directly.
 */
@Module({
  providers: [
    {
      provide: FLUTTERWAVE_CLIENT,
      useFactory: (config: ConfigService<AppConfig, true>) => new FlutterwaveClient(config),
      inject: [ConfigService],
    },
    AesGcmCardCredentialEncryptor,
    { provide: CardCredentialEncryptor, useExisting: AesGcmCardCredentialEncryptor },
    FlutterwaveCardsService,
  ],
  exports: [FLUTTERWAVE_CLIENT, CardCredentialEncryptor, FlutterwaveCardsService],
})
export class FlutterwaveModule {}
