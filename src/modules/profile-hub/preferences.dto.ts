import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  Matches,
} from 'class-validator';

export const DEFAULT_PREFERENCES = {
  theme: 'dark',
  hideBalances: false,
  language: 'en',
  region: 'NG',
  dateFormat: 'd MMM yyyy',
  timeZone: 'device',
  autoLockSeconds: 60,
  emailNotifications: true,
  approvalAlerts: true,
  transactionUpdates: true,
  spendingAlerts: true,
  renewalReminders: true,
  productNews: false,
};
export class PreferencesDto {
  @IsOptional() @IsIn(['system', 'light', 'dark']) theme?: string;
  @IsOptional() @IsBoolean() hideBalances?: boolean;
  @IsOptional() @IsIn(['en', 'device']) language?: string;
  @IsOptional() @IsIn(['NG', 'GB', 'US', 'CA']) region?: string;
  @IsOptional() @IsIn(['d MMM yyyy', 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd']) dateFormat?: string;
  @IsOptional()
  @IsIn(['device', 'UTC', 'Africa/Lagos', 'Europe/London', 'America/New_York'])
  timeZone?: string;
  @IsOptional() @IsIn([0, 30, 60, 120, 300]) autoLockSeconds?: number;
  @IsOptional() @IsBoolean() emailNotifications?: boolean;
  @IsOptional() @IsBoolean() approvalAlerts?: boolean;
  @IsOptional() @IsBoolean() transactionUpdates?: boolean;
  @IsOptional() @IsBoolean() spendingAlerts?: boolean;
  @IsOptional() @IsBoolean() renewalReminders?: boolean;
  @IsOptional() @IsBoolean() productNews?: boolean;
}
export class SupportRequestDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  subject: string;
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(5)
  @MaxLength(4000)
  message: string;
}
export class ConfirmPasscodeDto {
  @IsString() @Matches(/^\d{4}$/) passcode: string;
}

export class EmailChangeDto extends ConfirmPasscodeDto {
  @IsEmail() @MaxLength(254) email: string;
}
