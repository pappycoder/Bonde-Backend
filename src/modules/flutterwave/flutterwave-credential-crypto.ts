import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decrypt, encrypt } from '../../common/crypto/aes-gcm.js';
import type { AppConfig } from '../../config/configuration.js';

export interface CardCredentials {
  pan: string;
  cvv: string;
}

/**
 * Encrypts/decrypts provider-issued card credentials (PAN + CVV) at rest with
 * AES-256-GCM, keyed by `encryption.cardKey`. Injection seam keeps the card
 * domain service testable without touching the real crypto module.
 */
export abstract class CardCredentialEncryptor {
  abstract encryptPan(pan: string): string;
  abstract encryptCvv(cvv: string): string;
  abstract decrypt(encryptedPan: string, encryptedCvv?: string): CardCredentials;
}

@Injectable()
export class AesGcmCardCredentialEncryptor extends CardCredentialEncryptor {
  private readonly key: string;

  constructor(config: ConfigService<AppConfig, true>) {
    super();
    this.key = config.get('encryption.cardKey', { infer: true });
  }

  encryptPan(pan: string): string {
    return encrypt(pan, this.key);
  }

  encryptCvv(cvv: string): string {
    return encrypt(cvv, this.key);
  }

  decrypt(encryptedPan: string, encryptedCvv?: string): CardCredentials {
    return {
      pan: decrypt(encryptedPan, this.key),
      cvv: encryptedCvv ? decrypt(encryptedCvv, this.key) : '',
    };
  }
}
