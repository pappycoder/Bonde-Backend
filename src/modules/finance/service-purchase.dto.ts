import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsIn, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { serviceIds } from './safe-haven-vas.client.js';
export class ServiceVerifyDto {
  @IsIn(serviceIds) serviceId!: string;
  @Matches(/^\d{6,20}$/) beneficiary!: string;
}
export class ServiceQuoteDto {
  @IsIn(serviceIds) serviceId!: string;
  @IsString() @MaxLength(100) variationCode!: string;
  @Matches(/^\d{6,20}$/) beneficiary!: string;
  @Matches(/^(?:0[789]\d{9}|234[789]\d{9}|\+234[789]\d{9})$/) phone!: string;
}
export class ServiceProofDto {
  @IsUUID('4') quoteId!: string;
  @Matches(/^\d{4}$/) passcode!: string;
}
export class ServiceExecuteDto {
  @IsUUID('4') quoteId!: string;
  @IsString() @MaxLength(100) proof!: string;
  @Matches(/^[a-zA-Z0-9_-]{16,100}$/) requestKey!: string;
}
export class ServiceReminderDto {
  @IsDateString() dueAt!: string;
}

export class ServiceQuoteViewDto {
  id!: string;
  serviceId!: string;
  variationCode!: string;
  name!: string;
  beneficiary!: string;
  beneficiaryName!: string | null;
  phone!: string;
  amount!: string;
  fee!: string;
  total!: string;
  currency!: string;
  expiresAt!: Date;
  autoRenew!: boolean;
}
export class ServiceOrderViewDto {
  id!: string;
  status!: string;
  @ApiProperty({ type: () => ServiceQuoteViewDto }) quote!: ServiceQuoteViewDto;
  providerTransactionId!: string | null;
  confirmedAt!: Date | null;
  createdAt!: Date;
}
