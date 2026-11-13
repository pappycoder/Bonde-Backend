import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class AiUsageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) days = 30;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @IsOptional() @IsString() @MaxLength(100) q = '';
  @IsOptional() @IsUUID() userId?: string;
}
export class AiProviderDto {
  @IsIn(['OPENAI', 'BRAVE']) provider: 'OPENAI' | 'BRAVE';
}
export class AiThresholdsDto extends AiProviderDto {
  @IsInt() @Min(1) @Max(99) warningPercent: number;
  @IsInt() @Min(0) @Max(98) criticalPercent: number;
  @IsArray() @ArrayMaxSize(10) @IsEmail({}, { each: true }) emailRecipients: string[];
}
export class AiFundingDto extends AiProviderDto {
  @IsOptional() @IsIn(['TOP_UP', 'BALANCE']) operation?: 'TOP_UP' | 'BALANCE';
  @IsUUID('4') reference: string;
  @Matches(/^\d{1,10}(\.\d{1,8})?$/) amountUsd: string;
  @IsString() @MaxLength(255) note: string;
}
export class AiRateDto extends AiProviderDto {
  @IsString() @Matches(/^[a-zA-Z0-9._-]{1,100}$/) model: string;
  @Matches(/^\d{1,10}(\.\d{1,8})?$/) inputPerMillion: string;
  @Matches(/^\d{1,10}(\.\d{1,8})?$/) cachedInputPerMillion: string;
  @Matches(/^\d{1,10}(\.\d{1,8})?$/) outputPerMillion: string;
  @Matches(/^\d{1,10}(\.\d{1,8})?$/) searchPerThousand: string;
}
