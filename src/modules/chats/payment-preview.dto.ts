import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class FlightEndpointDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10)
  code: string;
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  airport: string;
  // Preserve the airport-local display date/time and explicit timezone.
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  date: string;
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  time: string;
  @IsOptional()
  @IsString()
  @MaxLength(100)
  note?: string;
}

/** Optional, provider-neutral display metadata. The enclosing item's amount
 * remains the authoritative payable total; recurring rates are separate. */
export class PaymentPreviewDto {
  @ApiProperty({ enum: ['RETAIL', 'FLIGHT', 'SUBSCRIPTION', 'SOFTWARE'] })
  @IsIn(['RETAIL', 'FLIGHT', 'SUBSCRIPTION', 'SOFTWARE'])
  mode: 'RETAIL' | 'FLIGHT' | 'SUBSCRIPTION' | 'SOFTWARE';
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subtitle?: string;
  @IsOptional()
  @IsString()
  @MaxLength(500)
  breakdown?: string;
  @IsOptional()
  @IsObject()
  selection?: Record<string, string>;
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  delivery?: string;
  @IsOptional()
  @IsString()
  @MaxLength(100)
  flightNumber?: string;
  @IsOptional()
  @IsString()
  @MaxLength(100)
  stops?: string;
  @IsOptional()
  @IsString()
  @MaxLength(100)
  duration?: string;
  @ValidateIf(
    (preview: PaymentPreviewDto) => preview.mode === 'FLIGHT' || preview.departure !== undefined,
  )
  @IsDefined()
  @ValidateNested()
  @Type(() => FlightEndpointDto)
  departure?: FlightEndpointDto;
  @ValidateIf(
    (preview: PaymentPreviewDto) => preview.mode === 'FLIGHT' || preview.arrival !== undefined,
  )
  @IsDefined()
  @ValidateNested()
  @Type(() => FlightEndpointDto)
  arrival?: FlightEndpointDto;
  @IsOptional()
  @IsString()
  @MaxLength(200)
  travellers?: string;
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  baggage?: string;
  @IsOptional()
  @IsString()
  @MaxLength(200)
  plan?: string;
  @IsOptional()
  @IsString()
  @MaxLength(100)
  seats?: string;
  @IsOptional()
  @IsString()
  @MaxLength(100)
  billing?: string;
  @IsOptional()
  @IsString()
  @MaxLength(200)
  period?: string;
  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  features?: string[];
  @IsOptional()
  @Matches(/^\d{1,13}(\.\d{1,2})?$/)
  recurringAmount?: string;
  @IsOptional()
  @IsString()
  @MaxLength(100)
  renewalDate?: string;
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  renewalTerms?: string;
  @IsOptional()
  @IsBoolean()
  autoRenew?: boolean;
}
