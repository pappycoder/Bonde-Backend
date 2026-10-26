import { ApiProperty } from '@nestjs/swagger';

/** A user's single wallet, returned to the owning user. */
export class WalletDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  accountId: string;

  @ApiProperty({
    example: '5000.00',
    description: 'Authoritative balance (fixed 2-decimal string)',
  })
  balance: string;

  @ApiProperty({ example: '0.00' })
  allocated: string;

  @ApiProperty({ example: '0.00' })
  held: string;

  @ApiProperty({ example: true })
  live: boolean;

  @ApiProperty({ example: 'NGN' })
  currency: string;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}
