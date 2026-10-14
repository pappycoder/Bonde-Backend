import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  Matches,
  MaxLength,
  IsUUID,
  ValidateIf,
  IsIn,
} from 'class-validator';

const DECIMAL_PATTERN = /^\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class DepositAccountDto {
  @ApiProperty({ example: '8061234567' })
  accountNumber: string;

  @ApiProperty({ example: 'Wema Bank' })
  bankName: string;

  @ApiProperty({ example: 'BONDE USER', nullable: true })
  accountName: string | null;

  @ApiProperty({ example: 'NGN' })
  currency: string;

  @ApiProperty({ example: false, description: 'Static accounts are permanent' })
  isPermanent: boolean;

  @ApiProperty({
    example: '2026-01-01T12:00:00.000Z',
    nullable: true,
    description: 'Dynamic accounts expire; null for permanent VAs',
  })
  expiresAt: string | null;
}

export class CreateWithdrawalDto {
  @ApiProperty({ example: '5000.00' })
  @Matches(DECIMAL_PATTERN, { message: 'amount must be a decimal with up to 2 places' })
  amount: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'An account saved by this authenticated user',
  })
  @IsOptional()
  @IsUUID('4')
  bankAccountId?: string;

  @ApiPropertyOptional({ example: '0690000034' })
  @ValidateIf((dto: CreateWithdrawalDto) => !dto.bankAccountId || dto.accountNumber !== undefined)
  @IsNotEmpty()
  @Matches(/^\d{3,10}$/, { message: 'accountNumber must be a bank account number' })
  accountNumber?: string;

  @ApiPropertyOptional({ example: '044' })
  @ValidateIf((dto: CreateWithdrawalDto) => !dto.bankAccountId || dto.bankCode !== undefined)
  @IsNotEmpty()
  @MaxLength(10)
  bankCode?: string;

  @ApiPropertyOptional({ example: 'NGN', default: 'NGN' })
  @IsOptional()
  @Matches(CURRENCY_PATTERN, { message: 'currency must be a 3-letter code' })
  currency?: string;

  @ApiPropertyOptional({ example: 'Rent' })
  @IsOptional()
  @MaxLength(255)
  narration?: string;
}

export class WithdrawalResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: '5000.00' })
  amount: string;

  @ApiProperty({ example: 'NGN' })
  currency: string;

  @ApiProperty({ example: 'PENDING' })
  status: string;
}

export class ResolveBankAccountDto {
  @ApiProperty({ example: '044' })
  @Matches(/^\d{3,10}$/)
  bankCode: string;

  @ApiProperty({ example: '0690000034' })
  @Matches(/^\d{10}$/)
  accountNumber: string;
}

export class BankDto {
  @ApiProperty({ example: 'Access Bank' })
  name: string;

  @ApiProperty({ example: '044' })
  code: string;
}

export class ResolvedBankAccountDto {
  @ApiProperty({ example: '0690000034' })
  accountNumber: string;

  @ApiProperty({ example: 'BONDE USER' })
  accountName: string;
}

export class SavedBankAccountDto extends ResolvedBankAccountDto {
  @ApiProperty({ format: 'uuid' })
  id: string;
  @ApiProperty({ example: '044' })
  bankCode: string;
  @ApiProperty({ example: 'Access Bank' })
  bankName: string;
  @ApiProperty({ format: 'date-time' })
  verifiedAt: Date;
  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}
export class DeleteBankAccountResponseDto {
  @ApiProperty({ example: true })
  deleted: boolean;
  @ApiProperty({ format: 'uuid' })
  id: string;
}

export class UpdateMonthlyBudgetDto {
  @ApiProperty({ example: '5000.00' })
  @Matches(/^\d{1,13}(\.\d{1,2})?$/)
  monthlyBudget: string;
}
export class CategorizeWalletTransactionDto {
  @ApiProperty({
    enum: ['GROCERIES', 'ENTERTAINMENT', 'TRAVEL', 'DINING', 'SHOPPING', 'ELECTRICITY'],
  })
  @IsIn(['GROCERIES', 'ENTERTAINMENT', 'TRAVEL', 'DINING', 'SHOPPING', 'ELECTRICITY'])
  category: string;
}
export class WalletCategoryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;
  @ApiProperty({ example: 'GROCERIES' })
  category: string;
}
export class WalletBudgetAllocationDto {
  id: string;
  cardName: string;
  last4: string;
  monthlyLimit: string;
  spent: string;
  lockTypes: string[];
}
export class WalletBudgetDto {
  walletId: string;
  currency: string;
  @ApiProperty({ nullable: true, type: String, example: '5000.00' })
  monthlyBudget: string | null;
  spent: string;
  periodStart: string;
  resetAt: string;
  daysRemaining: number;
  @ApiProperty({ type: [WalletBudgetAllocationDto] })
  allocations: WalletBudgetAllocationDto[];
}
