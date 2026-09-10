import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, Matches } from 'class-validator';

const ACCOUNT_NUMBER_PATTERN = /^\d{10,20}$/;

/** A user's single bank account, returned to the owning user. */
export class AccountDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  userId: string;

  @ApiProperty({ example: '0123456789' })
  accountNumber: string;

  @ApiProperty({ enum: AccountType, example: AccountType.CHECKING })
  accountType: AccountType;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

/** Body for `POST /api/account` (one per user, 409 on conflict). */
export class CreateAccountDto {
  @ApiPropertyOptional({
    example: '0123456789',
    description: 'Bank-style account number (Luhn). Generated when omitted.',
  })
  @IsOptional()
  @Matches(ACCOUNT_NUMBER_PATTERN, { message: 'accountNumber must be 10-20 digits' })
  accountNumber?: string;

  @ApiPropertyOptional({ enum: AccountType, example: AccountType.CHECKING })
  @IsOptional()
  @IsEnum(AccountType)
  accountType?: AccountType;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Body for `PATCH /api/account`. */
export class UpdateAccountDto {
  @ApiPropertyOptional({ enum: AccountType, example: AccountType.SAVINGS })
  @IsOptional()
  @IsEnum(AccountType)
  accountType?: AccountType;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Response for `DELETE /api/account`. */
export class AccountsDeleteResponseDto {
  @ApiProperty({ example: true })
  deleted: true;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;
}
