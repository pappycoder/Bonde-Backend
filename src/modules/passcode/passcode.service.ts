import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const scrypt = promisify(scryptCb);
const KEY_LENGTH = 64;

interface StoredCredentials {
  salt: string;
  hash: string;
}

/**
 * One-time 4-digit passcode keyed 1:1 per profile. The passcode is stored as
 * an scrypt digest with a per-user random salt (never plaintext), and carries
 * the failed-attempt counter + lockout window that gate brute-force attempts.
 *
 * Validate is exposed so the transactions/approval flow can re-authorize a
 * sensitive mutation server-side before proceeding.
 */
@Injectable()
export class PasscodeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async getStatus(userId: string): Promise<{ hasPasscode: boolean }> {
    const existing = await this.prisma.passcode.findUnique({ where: { userId } });
    return { hasPasscode: existing !== null };
  }

  async create(userId: string, passcode: string): Promise<{ hasPasscode: true }> {
    const { salt, hash } = await this.hash(passcode);
    try {
      await this.prisma.passcode.create({
        data: { id: randomUUID(), userId, salt, hash },
      });
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === 'P2002'
      ) {
        throw new ConflictException('Passcode already set');
      }
      throw error;
    }
    return { hasPasscode: true };
  }

  async update(userId: string, current: string, next: string): Promise<{ hasPasscode: true }> {
    const existing = await this.getOwned(userId);
    await this.verifyOrThrow(userId, existing, current, 'Current passcode is incorrect');
    const { salt, hash } = await this.hash(next);
    await this.prisma.passcode.update({
      where: { id: existing.id },
      data: { salt, hash, failedAttempts: 0, lockedUntil: null },
    });
    return { hasPasscode: true };
  }

  async validate(userId: string, passcode: string): Promise<{ valid: true }> {
    const existing = await this.getOwned(userId);
    await this.verifyOrThrow(userId, existing, passcode, 'Invalid passcode');
    return { valid: true };
  }

  private async getOwned(userId: string) {
    const existing = await this.prisma.passcode.findUnique({ where: { userId } });
    if (!existing) throw new NotFoundException('Passcode not set');
    return existing;
  }

  private async verifyOrThrow(
    userId: string,
    existing: {
      id: string;
      salt: string;
      hash: string;
      failedAttempts: number;
      lockedUntil: Date | null;
    },
    passcode: string,
    failureMessage: string,
  ): Promise<void> {
    if (existing.lockedUntil && existing.lockedUntil.getTime() > Date.now()) {
      throw new UnauthorizedException(this.lockMessage(existing.lockedUntil));
    }

    if (await this.verify(passcode, existing.salt, existing.hash)) {
      if (existing.failedAttempts > 0 || existing.lockedUntil) {
        await this.prisma.passcode.update({
          where: { id: existing.id },
          data: { failedAttempts: 0, lockedUntil: null },
        });
      }
      return;
    }

    const maxAttempts = this.config.get('passcode').maxAttempts;
    const lockMinutes = this.config.get('passcode').lockMinutes;
    const nextAttempts = existing.failedAttempts + 1;
    const locked = nextAttempts >= maxAttempts;
    await this.prisma.passcode.update({
      where: { id: existing.id },
      data: {
        failedAttempts: locked ? 0 : nextAttempts,
        lockedUntil: locked ? new Date(Date.now() + lockMinutes * 60_000) : null,
      },
    });
    throw new UnauthorizedException(
      locked
        ? `Too many failed attempts. Passcode locked for ${lockMinutes} minutes`
        : failureMessage,
    );
  }

  private lockMessage(lockedUntil: Date): string {
    const minutes = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 60_000));
    return `Too many failed attempts. Passcode locked for ${minutes} more minute${minutes === 1 ? '' : 's'}`;
  }

  private async hash(passcode: string): Promise<StoredCredentials> {
    const salt = randomBytes(16).toString('hex');
    const derived = (await scrypt(passcode, salt, KEY_LENGTH)) as Buffer;
    return { salt, hash: derived.toString('hex') };
  }

  private async verify(passcode: string, salt: string, expectedHex: string): Promise<boolean> {
    const derived = (await scrypt(passcode, salt, KEY_LENGTH)) as Buffer;
    const expected = Buffer.from(expectedHex, 'hex');
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  }
}
