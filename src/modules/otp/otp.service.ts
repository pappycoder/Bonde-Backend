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

export const OTP_CODE_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000;

/**
 * App-level OTP verification (e.g. phone/email proof-of-control). Codes are
 * 6-digit, stored as SHA-256 digests (never plaintext), expire after 5 minutes,
 * are single-use, and sending a new code invalidates earlier ones. Delivery
 * goes through the injected `OTP_SENDER` boundary and fails closed (503) when
 * the provider is down — a code that was never delivered must never be usable.
 */
@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
  ) {}

  async send(principal: AuthPrincipal, dto: SendOtpDto): Promise<{ status: 'sent' }> {
    await this.assertOwnTarget(principal, dto.channel, dto.target);

    const code = this.generateCode();
    const digest = this.hashCode(code);

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.otpCode.updateMany({
        where: { userId: principal.userId, channel: dto.channel, used: false },
        data: { used: true },
      });
      return tx.otpCode.create({
        data: {
          id: randomUUID(),
          userId: principal.userId,
          code: digest,
          channel: dto.channel,
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
          used: false,
        },
      });
    });

    try {
      await this.sender.send({ channel: dto.channel, target: dto.target, code });
    } catch (error) {
      if (error instanceof OtpSendError) {
        await this.invalidateCode(created.id);
        throw new ServiceUnavailableException('Unable to send verification code');
      }
      throw error;
    }

    return { status: 'sent' as const };
  }

  async verify(principal: AuthPrincipal, dto: VerifyOtpDto): Promise<{ verified: true }> {
    await this.assertOwnTarget(principal, dto.channel, dto.target);

    const candidate = await this.prisma.otpCode.findFirst({
      where: {
        userId: principal.userId,
        channel: dto.channel,
        used: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!candidate) throw new BadRequestException('Invalid verification code');

    if (!this.safeEqual(this.hashCode(dto.code), candidate.code)) {
      throw new BadRequestException('Invalid verification code');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.otpCode.update({
        where: { id: candidate.id },
        data: { used: true },
      });
      await this.markVerified(tx, principal, dto.channel, dto.target);
    });

    return { verified: true as const };
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

  private generateCode(): string {
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

  private async invalidateCode(id: string): Promise<void> {
    await this.prisma.otpCode.update({
      where: { id },
      data: { used: true },
    });
  }

  private async markVerified(
    tx: Prisma.TransactionClient,
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
    const profile = await tx.profile.findUnique({
      where: { id: principal.userId },
      select: { phone: true },
    });
    if (!profile) return;
    if (channel === OtpChannel.PHONE && profile.phone !== target.trim()) return;
    await tx.profile.update({ where: { id: principal.userId }, data });
  }
}
