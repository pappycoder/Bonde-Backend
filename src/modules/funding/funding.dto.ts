import { ApiProperty } from '@nestjs/swagger';
import { IsIn, Matches } from 'class-validator';

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
  @ApiProperty({ example: '100.00' })
  cardSpent: string;
  @ApiProperty({ example: '1000.00' })
  cardLimit: string;
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
