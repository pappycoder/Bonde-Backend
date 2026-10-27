import { Transform } from 'class-transformer';
import { IsString, Length, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** The complete saved address; optional address lines are represented as empty strings. */
export class DeliveryAddressDto {
  @Transform(trim)
  @IsString()
  @Length(1, 255)
  street: string;

  @ApiPropertyOptional({ default: '' })
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  addressLine2: string = '';

  @Transform(trim)
  @IsString()
  @Length(1, 100)
  city: string;

  @Transform(trim)
  @IsString()
  @Length(1, 100)
  region: string;

  @Transform(trim)
  @IsString()
  @Length(1, 100)
  country: string;

  @ApiPropertyOptional({ default: '' })
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  postalCode: string = '';
}

export class DeliveryRecipientDto {
  name: string;
  @ApiProperty({ type: String, nullable: true })
  phone: string | null;
}

export interface DeliveryContext {
  deliveryAddress: DeliveryAddressDto | null;
  recipient: DeliveryRecipientDto;
}

export const deliveryAddressSelect = {
  street: true,
  addressLine2: true,
  city: true,
  region: true,
  country: true,
  postalCode: true,
} as const;
