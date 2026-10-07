import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/**
 * Body for `POST /api/kyc/verify`. Both identifiers are required and must be
 * 11 digits (Nigerian BVN/NIN format). The values are verified against the
 * provider and then discarded — only keyed digests are persisted.
 */
export class VerifyKycDto {
  @ApiProperty({ example: '22345678901', description: '11-digit BVN' })
  @IsString()
  @Matches(/^\d{11}$/, { message: 'bvn must be 11 digits' })
  bvn: string;

  @ApiProperty({ example: '12345678901' })
  @IsString()
  @Matches(/^\d{11}$/, { message: 'nin must be 11 digits' })
  nin: string;
}

/**
 * KYC status returned to the owner. Contains **no identifiers** — only whether
 * each one has been verified and the overall outcome.
 */
export class KycStatusDto {
  @ApiProperty({ enum: ['PENDING', 'VERIFIED', 'FAILED'], example: 'VERIFIED' })
  status: string;

  @ApiProperty({ example: true })
  bvnVerified: boolean;

  @ApiProperty({ example: true })
  ninVerified: boolean;

  @ApiProperty({ example: true, description: 'True only when both BVN and NIN pass' })
  identityVerified: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  bvnVerifiedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  ninVerifiedAt: Date | null;
}
