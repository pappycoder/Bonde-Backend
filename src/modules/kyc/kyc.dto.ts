import { ApiProperty } from '@nestjs/swagger';

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

  @ApiProperty({
    example: true,
    description: 'True after Safe Haven verifies a supported banking identity',
  })
  identityVerified: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  bvnVerifiedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  ninVerifiedAt: Date | null;
}
