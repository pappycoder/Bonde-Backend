import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { OtpChannel, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { OTP_SENDER, OtpSendError, type OtpSender } from './otp-sender.interface.js';
import { SendOtpDto, VerifyOtpDto } from './otp.dto.js';

export const OTP_CODE_LENGTH = 4;
const OTP_TTL_MS = 5 * 60 * 1000;

/**
 * App-level OTP verification (phone/email proof-of-control). Codes are 4-digit,
 * stored as SHA-256 digests (never plaintext), expire after 5 minutes, are
 * single-use, and sending a new code invalidates earlier ones.
 *
 * The principal-free `generateCode` / `consumeCode` primitives let the auth
 * flow (registration + password recovery) reuse the exact same issuance and
 * single-use semantics before a session exists. Delivery always crosses the
 * injected `OTP_SENDER` boundary and fails closed (503) when the provider is
 * down — a code that was never delivered must never be usable.
 */
@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
  ) {}

  /** Authenticated wrapper for `POST /api/otp/send`. */
  async send(principal: AuthPrincipal, dto: SendOtpDto): Promise<{ status: 'sent' }> {
    await this.assertOwnTarget(principal, dto.channel, dto.target);

    const code = await this.generateCode(principal.userId, dto.channel);
    try {
      await this.sender.send({ channel: dto.channel, target: dto.target, code });
    } catch (error) {
      if (error instanceof OtpSendError) {
        await this.invalidate(principal.userId, dto.channel);
        throw new ServiceUnavailableException('Unable to send verification code');
      }
      throw error;
    }

    return { status: 'sent' as const };
  }

  /** Authenticated wrapper for `POST /api/otp/verify`. */
  async verify(principal: AuthPrincipal, dto: VerifyOtpDto): Promise<{ verified: true }> {
    await this.assertOwnTarget(principal, dto.channel, dto.target);

    const ok = await this.consumeCode(principal.userId, dto.channel, dto.code);
    if (!ok) throw new BadRequestException('Invalid verification code');
    await this.markVerified(principal, dto.channel, dto.target);

    return { verified: true as const };
  }

  // ---------------------------------------------------------------------------
  // Principal-free primitives (shared with the auth flow)
  // ---------------------------------------------------------------------------

  /**
   * Issue a fresh code for the user+channel pair, voiding any earlier unused
   * codes. Returns the plaintext code — the caller owns delivery (the
   * `OTP_SENDER` boundary). Only the SHA-256 digest is persisted.
   */
  async generateCode(userId: string, channel: OtpChannel): Promise<string> {
    const code = this.randomCode();
    const digest = this.hashCode(code);

    await this.prisma.$transaction(async (tx) => {
      await tx.otpCode.updateMany({
        where: { userId, channel, used: false },
        data: { used: true },
      });
      await tx.otpCode.create({
        data: {
          id: randomUUID(),
          userId,
          code: digest,
          channel,
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
          used: false,
        },
      });
    });

    return code;
  }

  /** Single-use consume. True only when a matching, unexpired code is found. */
  async consumeCode(userId: string, channel: OtpChannel, code: string): Promise<boolean> {
    const candidate = await this.prisma.otpCode.findFirst({
      where: {
        userId,
        channel,
        used: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!candidate) return false;

    if (!this.safeEqual(this.hashCode(code), candidate.code)) return false;

    await this.prisma.otpCode.update({
      where: { id: candidate.id },
      data: { used: true },
    });
    return true;
  }

  /** Void every unused code for the user+channel pair (fail-closed delivery). */
  async invalidate(userId: string, channel: OtpChannel): Promise<void> {
    await this.prisma.otpCode.updateMany({
      where: { userId, channel, used: false },
      data: { used: true },
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async assertOwnTarget(
    principal: AuthPrincipal,
    channel: OtpChannel,
    target: string,
  ): Promise<void> {
    const trimmed = target.trim();
    const profile = await this.prisma.profile.findUnique({
      where: { id: principal.userId },
      select: { phone: true },
    });
    const allowed =
      channel === OtpChannel.EMAIL
        ? [principal.email]
        : [principal.phone, profile?.phone ?? null].filter((v): v is string => Boolean(v));
    if (!allowed.includes(trimmed)) {
      throw new BadRequestException('Target does not belong to this account');
    }
  }

  private async markVerified(
    principal: AuthPrincipal,
    channel: OtpChannel,
    target: string,
  ): Promise<void> {
    const data: Prisma.ProfileUpdateInput = {};
    if (channel === OtpChannel.PHONE) {
      data.phoneVerified = true;
    } else {
      data.emailVerified = true;
    }
    if (!Object.keys(data).length) return;

    const profile = await this.prisma.profile.findUnique({
      where: { id: principal.userId },
      select: { phone: true },
    });
    if (!profile) return;
    if (channel === OtpChannel.PHONE && profile.phone !== target.trim()) return;
    await this.prisma.profile.update({ where: { id: principal.userId }, data });
  }

  private randomCode(): string {
    return randomInt(0, 10 ** OTP_CODE_LENGTH)
      .toString()
      .padStart(OTP_CODE_LENGTH, '0');
  }

  private hashCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  private safeEqual(a: string, b: string): boolean {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
  }
}
