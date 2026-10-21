import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
export class BillingOrderDto {
  @IsUUID('4') idempotencyKey: string;
  @IsString()
  @IsIn(['premium-monthly', 'starter-10', 'pack-50', 'pack-60', 'pack-70'])
  productId: string;
  @IsIn(['WALLET', 'CARD', 'NEW_CARD']) paymentMethod: string;
  @IsOptional() @IsUUID('4') cardId?: string;
  @IsOptional() @IsBoolean() recurringConsent?: boolean;
}
export class BillingConfirmDto {
  @IsString() @Matches(/^\d{4}$/) passcode: string;
}
