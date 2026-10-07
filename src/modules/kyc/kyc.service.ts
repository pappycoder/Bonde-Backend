import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationType, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { hmacSha256 } from '../../common/crypto/hmac-sha256.js';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { KycStatusDto, VerifyKycDto } from './kyc.dto.js';
import { KYC_PROVIDER, KycProviderError, type KycProvider } from './kyc.types.js';

/**
 * Identity verification for a signed-in user.
 *
 * Only the **BVN** is checked against the provider; the **NIN** is collected and
 * stored but not verified. Raw identifiers are sent to the provider (or, for the
 * NIN, not sent at all) and then discarded — only an HMAC-SHA-256 digest (keyed
 * by `KYC_HASH_SECRET`) is stored, so a database dump cannot be brute-forced
 * against the 11-digit space or replayed. The overall status is `VERIFIED` once
 * the BVN matches; a failed BVN is persisted as `FAILED` and can be retried.
 */
@Injectable()
export class KycService {
  private readonly hashSecret: string;
  private readonly providerName: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    @Inject(KYC_PROVIDER) private readonly provider: KycProvider,
    config: ConfigService<AppConfig, true>,
  ) {
    const kyc = config.get('kyc');
    this.hashSecret = kyc.hashSecret;
    this.providerName = kyc.provider;
  }

  /** Current verification state for the owner (never includes identifiers). */
  async status(userId: string): Promise<KycStatusDto> {
    const row = await this.prisma.kycVerification.findUnique({ where: { userId } });
    return toDto(row);
  }

  /**
   * Verify the supplied BVN and store the supplied NIN. An already-verified BVN
   * is not re-checked, so a retry after a failure is cheap. Provider
   * (infrastructure) failures map to HTTP 502/503; a provider "not verified"
   * answer is persisted as a failed attempt and returned in the status.
   */
  async verify(userId: string, dto: VerifyKycDto): Promise<KycStatusDto> {
    const existing = await this.prisma.kycVerification.findUnique({ where: { userId } });
    const now = new Date();

    const data: Prisma.KycVerificationUncheckedCreateInput = {
      id: existing?.id ?? randomUUID(),
      userId,
      provider: this.providerName,
      bvnHash: existing?.bvnHash ?? null,
      ninHash: hmacSha256(dto.nin, this.hashSecret),
      bvnVerifiedAt: existing?.bvnVerifiedAt ?? null,
      ninVerifiedAt: null,
      providerRef: (existing?.providerRef as Prisma.InputJsonValue) ?? {},
    };

    const refs: Record<string, unknown> = {};
    let providerError: unknown = null;

    if (!existing?.bvnVerifiedAt) {
      try {
        const outcome = await this.provider.verifyBvn(dto.bvn);
        refs.bvn = { verified: outcome.verified, reference: outcome.reference ?? null };
        if (outcome.verified) {
          data.bvnHash = hmacSha256(dto.bvn, this.hashSecret);
          data.bvnVerifiedAt = now;
        }
      } catch (error) {
        providerError = error;
      }
    }

    data.status = data.bvnVerifiedAt ? 'VERIFIED' : 'FAILED';

    // Persist whatever we learned before surfacing an infra error, so the
    // collected NIN and any successful BVN check are not lost on a retry.
    const saved = await this.persist(userId, data, refs);
    if (providerError) throw this.toHttp(providerError);

    await this.afterVerify(userId, saved);
    return toDto(saved);
  }

  private async persist(
    userId: string,
    data: Prisma.KycVerificationUncheckedCreateInput,
    refs: Record<string, unknown>,
  ) {
    const base = data.providerRef as Record<string, unknown> | undefined;
    const providerRef = { ...base, ...refs } as Prisma.InputJsonValue;
    return this.prisma.kycVerification.upsert({
      where: { userId },
      create: { ...data, providerRef },
      update: {
        provider: data.provider,
        bvnHash: data.bvnHash,
        ninHash: data.ninHash,
        bvnVerifiedAt: data.bvnVerifiedAt,
        ninVerifiedAt: data.ninVerifiedAt,
        status: data.status,
        providerRef,
      },
    });
  }

  private async afterVerify(userId: string, row: { id: string; status: string }): Promise<void> {
    const verified = row.status === 'VERIFIED';
    await this.activity.record({
      userId,
      action: 'kyc.verify',
      entityType: 'kyc_verification',
      entityId: row.id,
      notify: {
        type: NotificationType.SYSTEM,
        title: verified ? 'Identity verified' : 'Identity verification failed',
        content: verified
          ? 'Your BVN was verified successfully.'
          : 'We could not verify your BVN. Please check it and try again.',
      },
    });
  }

  private toHttp(error: unknown): Error {
    if (error instanceof KycProviderError) {
      switch (error.code) {
        case 'CONFIG':
          return new ServiceUnavailableException(error.message);
        case 'VALIDATION':
          return new BadRequestException(error.message);
        default:
          return new BadGatewayException(error.message);
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

function toDto(
  row: {
    status: string;
    bvnVerifiedAt: Date | null;
    ninVerifiedAt: Date | null;
  } | null,
): KycStatusDto {
  return {
    status: row?.status ?? 'PENDING',
    bvnVerified: row?.bvnVerifiedAt != null,
    ninVerified: row?.ninVerifiedAt != null,
    identityVerified: row?.bvnVerifiedAt != null,
    bvnVerifiedAt: row?.bvnVerifiedAt ?? null,
    ninVerifiedAt: row?.ninVerifiedAt ?? null,
  };
}
