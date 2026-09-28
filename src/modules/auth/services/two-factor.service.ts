import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt } from 'node:crypto';
import otplib from 'otplib';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { decrypt, encrypt } from '../../../common/crypto/aes-gcm.js';
import type { AppConfig } from '../../../config/configuration.js';

/**
 * Authenticator-app (TOTP) second factor.
 *
 * - The base32 secret is stored AES-256-GCM encrypted, keyed by
 *   `encryption.mfaKey`, so a database leak cannot be replayed against an
 *   authenticator app.
 * - Recovery codes are single use and stored as SHA-256 digests.
 * - TOTP codes are accepted once per 30s time step: `lastUsedStep` blocks both
 *   replay inside a step and stepping the clock backwards.
 */
/** Seconds each TOTP code stays valid. */
const TOTP_PERIOD_SECONDS = 30;

// `algorithm` is an enum in otplib's types, hence the cast on the literal.
const TOTP_OPTIONS = {
  algorithm: 'sha1',
  digits: 6,
  period: TOTP_PERIOD_SECONDS,
  /** Tolerate one step of clock drift on a slow phone. */
  window: 1,
} as typeof otplib.authenticator.options;
const ISSUER = 'Bonde';
const RECOVERY_CODE_COUNT = 10;
/** Unambiguous alphabet: no 0/O or 1/I, so a code can be retyped from a printout. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface TwoFactorStatus {
  enabled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
}

export interface TwoFactorSetup {
  secret: string;
  otpauthUri: string;
}

export interface TwoFactorEnrollment {
  recoveryCodes: string[];
}

@Injectable()
export class TwoFactorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    otplib.authenticator.options = { ...otplib.authenticator.options, ...TOTP_OPTIONS };
  }

  private get key(): string {
    return this.config.get('encryption.mfaKey', { infer: true });
  }

  private stepAt(at: number): number {
    return Math.floor(at / 1000 / TOTP_PERIOD_SECONDS);
  }

  /** Recovery codes are compared case- and dash-insensitively. */
  private normalizeRecoveryCode(code: string): string {
    return code
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  private digest(value: string): string {
    // Both the TOTP secret and the recovery codes are high-entropy random
    // values, so a plain SHA-256 digest is enough to make a stolen row useless.
    return createHash('sha256').update(value).digest('hex');
  }

  private generateRecoveryCodes(): { codes: string[]; hashes: string[] } {
    const codes: string[] = [];
    for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
      let code = '';
      for (let char = 0; char < 10; char += 1) {
        code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
      }
      codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
    }
    return { codes, hashes: codes.map((code) => this.digest(this.normalizeRecoveryCode(code))) };
  }

  /** Cheap check used on the login path to decide whether to park a session. */
  async isEnabled(userId: string): Promise<boolean> {
    const row = await this.prisma.twoFactor.findUnique({
      where: { userId },
      select: { enabledAt: true },
    });
    return row?.enabledAt != null;
  }

  async status(userId: string): Promise<TwoFactorStatus> {
    const row = await this.prisma.twoFactor.findUnique({ where: { userId } });
    if (!row) return { enabled: false, enrolledAt: null, recoveryCodesRemaining: 0 };
    return {
      enabled: row.enabledAt !== null,
      enrolledAt: row.enabledAt ? row.enabledAt.toISOString() : null,
      recoveryCodesRemaining: row.enabledAt ? row.recoveryHashes.length : 0,
    };
  }

  /**
   * Starts (or restarts) enrolment by storing a fresh encrypted secret and
   * returning it for the authenticator app. Nothing takes effect until
   * {@link enable} accepts a code from that app.
   */
  async startSetup(userId: string, email: string): Promise<TwoFactorSetup> {
    const secret = otplib.authenticator.generateSecret();
    const data = {
      secretEnc: encrypt(secret, this.key),
      recoveryHashes: [],
      enabledAt: null,
      lastUsedStep: 0,
    };
    await this.prisma.twoFactor.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return { secret, otpauthUri: otplib.authenticator.keyuri(email, ISSUER, secret) };
  }

  /** Confirms the first valid code, turns the second factor on, returns codes. */
  async enable(userId: string, code: string): Promise<TwoFactorEnrollment> {
    const row = await this.prisma.twoFactor.findUnique({ where: { userId } });
    if (!row) throw new BadRequestException('Start two-factor setup first');
    if (row.enabledAt) throw new BadRequestException('Two-factor authentication is already on');
    if (!this.checkCode(this.decode(row.secretEnc), code)) {
      throw new UnauthorizedException('Invalid authenticator code');
    }

    const { codes, hashes } = this.generateRecoveryCodes();
    await this.prisma.twoFactor.update({
      where: { userId },
      data: {
        enabledAt: new Date(),
        recoveryHashes: hashes,
        lastUsedStep: this.stepAt(Date.now()),
      },
    });
    return { recoveryCodes: codes };
  }

  async disable(userId: string): Promise<void> {
    await this.prisma.twoFactor.deleteMany({ where: { userId } });
  }

  /**
   * Verifies the second factor presented during sign-in. TOTP codes are
   * accepted once per time step; a recovery code is consumed on use.
   */
  async verify(userId: string, code: string): Promise<'totp' | 'recovery'> {
    const row = await this.prisma.twoFactor.findUnique({ where: { userId } });
    if (!row?.enabledAt) throw new UnauthorizedException('Two-factor authentication is not on');

    const step = this.stepAt(Date.now());
    if (this.checkCode(this.decode(row.secretEnc), code)) {
      if (step <= row.lastUsedStep) {
        throw new UnauthorizedException('That code has already been used');
      }
      await this.prisma.twoFactor.update({ where: { userId }, data: { lastUsedStep: step } });
      return 'totp';
    }

    const match = row.recoveryHashes.indexOf(this.digest(this.normalizeRecoveryCode(code)));
    if (match === -1) throw new UnauthorizedException('Invalid authenticator code');
    await this.prisma.twoFactor.update({
      where: { userId },
      data: { recoveryHashes: row.recoveryHashes.filter((_, index) => index !== match) },
    });
    return 'recovery';
  }

  private decode(secretEnc: string): string {
    try {
      return decrypt(secretEnc, this.key);
    } catch {
      throw new BadRequestException('Stored authenticator secret cannot be read');
    }
  }

  private checkCode(secret: string, code: string): boolean {
    const token = code.trim().replace(/\s+/g, '');
    if (!/^\d{6}$/.test(token)) return false;
    try {
      return otplib.authenticator.check(token, secret);
    } catch {
      return false;
    }
  }
}
