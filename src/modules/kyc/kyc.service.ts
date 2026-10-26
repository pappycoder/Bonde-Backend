import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

/** Banking identity status is owned by the verified Safe Haven onboarding flow. */
@Injectable()
export class KycService {
  constructor(private readonly prisma: PrismaService) {}
  async status(userId: string) {
    const [customer, verification] = await Promise.all([
      this.prisma.financeCustomer.findUnique({ where: { userId } }),
      this.prisma.kycVerification.findUnique({ where: { userId } }),
    ]);
    const verified = customer?.bankStatus === 'READY';
    const current = verification?.provider === 'safe-haven' ? verification : null;
    return {
      status: verified ? 'VERIFIED' : 'PENDING',
      identityVerified: verified,
      bvnVerified:
        verified && current?.bvnVerifiedAt != null && current.bvnHash === customer?.identityHash,
      ninVerified:
        verified && current?.ninVerifiedAt != null && current.ninHash === customer?.identityHash,
      bvnVerifiedAt:
        verified && current?.bvnHash === customer?.identityHash
          ? (current?.bvnVerifiedAt ?? null)
          : null,
      ninVerifiedAt:
        verified && current?.ninHash === customer?.identityHash
          ? (current?.ninVerifiedAt ?? null)
          : null,
    };
  }
}
