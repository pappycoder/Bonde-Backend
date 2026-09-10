import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, Matches } from 'class-validator';

const DECIMAL_PATTERN = /^\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

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

  @ApiProperty({ example: 'NGN' })
  currency: string;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

/** Body for `POST /api/wallet` (one per account, 409 on conflict). */
export class CreateWalletDto {
  @ApiPropertyOptional({ example: '0.00', default: '0.00' })
  @IsOptional()
  @Matches(DECIMAL_PATTERN, { message: 'balance must be a decimal with up to 2 places' })
  balance?: string;

  @ApiPropertyOptional({ example: 'NGN', default: 'NGN' })
  @IsOptional()
  @Matches(CURRENCY_PATTERN, { message: 'currency must be a 3-letter code' })
  currency?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Body for `PATCH /api/wallet`. */
export class UpdateWalletDto {
  @ApiPropertyOptional({ example: '5000.00' })
  @IsOptional()
  @Matches(DECIMAL_PATTERN, { message: 'balance must be a decimal with up to 2 places' })
  balance?: string;

  @ApiPropertyOptional({ example: 'NGN' })
  @IsOptional()
  @Matches(CURRENCY_PATTERN, { message: 'currency must be a 3-letter code' })
  currency?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Response for `DELETE /api/wallet`. */
export class WalletsDeleteResponseDto {
  @ApiProperty({ example: true })
  deleted: true;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;
}
