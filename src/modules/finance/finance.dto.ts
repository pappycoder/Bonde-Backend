import { Type } from 'class-transformer';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export const commandKinds = [
  'ISSUE',
  'ALLOCATE',
  'RETURN',
  'WITHDRAW',
  'PAUSE',
  'RESUME',
  'CANCEL',
  'RULES',
  'APPROVE',
  'DECLINE',
] as const;
export class FinanceCommandDto {
  @IsIn(commandKinds) kind!: (typeof commandKinds)[number];
  @IsIn(['NGN', 'USD']) currency!: 'NGN' | 'USD';
  @Matches(/^\d{1,12}(\.\d{1,2})?$/) amount!: string;
  @Matches(/^\d{1,12}(\.\d{1,2})?$/) fee!: string;
  @IsOptional() @IsString() @MaxLength(100) cardId?: string;
  @IsOptional() @IsString() @MaxLength(100) authorizationId?: string;
  @IsOptional() @IsString() @MaxLength(25) nickname?: string;
  @IsOptional() @IsString() @MaxLength(10) bankCode?: string;
  @IsOptional() @Matches(/^\d{10}$/) accountNumber?: string;
  @IsOptional() @IsString() @MaxLength(255) accountName?: string;
  @IsOptional() @IsIn(['lost', 'stolen']) cancellationReason?: 'lost' | 'stolen';
  @IsOptional() @IsObject() rules?: Record<string, unknown>;
}
export class FinanceProofDto {
  @ValidateNested() @Type(() => FinanceCommandDto) command!: FinanceCommandDto;
  @Matches(/^\d{4}$/) passcode!: string;
}
export class FinanceExecuteDto {
  @ValidateNested() @Type(() => FinanceCommandDto) command!: FinanceCommandDto;
  @IsString() @MaxLength(100) proof!: string;
}
export class FinanceIdentityDto {
  @IsString() @MaxLength(100) firstName!: string;
  @IsString() @MaxLength(100) lastName!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) dob!: string;
  @IsIn(['BVN', 'NIN']) identityType!: 'BVN' | 'NIN';
  @Matches(/^\d{11}$/) identityNumber!: string;
  @IsString() @MaxLength(200) line1!: string;
  @IsString() @MaxLength(100) city!: string;
  @IsString() @MaxLength(100) state!: string;
  @IsString() @MaxLength(20) postalCode!: string;
}
export class FinanceBankIdentityDto {
  @IsIn(['BVN', 'NIN']) identityType!: 'BVN' | 'NIN';
  @Matches(/^\d{11}$/) identityNumber!: string;
}
export class FinanceBankCompleteDto extends FinanceBankIdentityDto {
  @IsString() @MaxLength(100) identityId!: string;
  @Matches(/^\d{4,8}$/) otp!: string;
}

export class FinanceWalletViewDto {
  id!: string;
  currency!: string;
  balance!: string;
  allocated!: string;
  held!: string;
  isActive!: boolean;
  live!: boolean;
}
export class FinanceOperationViewDto {
  id!: string;
  kind!: string;
  status!: string;
  currency!: string;
  amount!: string;
  fee!: string;
  cardId!: string | null;
  createdAt!: Date;
}
export class FinanceProofViewDto {
  proof!: string;
  expiresAt!: Date;
}
export class FinanceDisplayViewDto {
  cardId!: string;
  token!: string;
}
