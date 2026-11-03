import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * A complete delivery address with its own recipient contact. Used as the body for
 * `POST/PATCH /api/profile/addresses` and for the one-time address attached to a
 * chat purchase item. Optional lines are represented as empty strings.
 */
export class DeliveryAddressInputDto {
  @ApiProperty({ example: 'Abiodun Oseni' })
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  recipientName: string;

  @ApiProperty({ example: '09034688362' })
  @Transform(trim)
  @IsString()
  @Matches(/^\+?[0-9][0-9\s-]{6,18}$/, {
    message: 'recipientPhone must be a valid phone number',
  })
  @MaxLength(20)
  recipientPhone: string;

  @ApiProperty({ example: '14, Efonalaye Street' })
  @Transform(trim)
  @IsString()
  @Length(1, 255)
  street: string;

  @ApiPropertyOptional({ default: '' })
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  addressLine2: string = '';

  @ApiProperty({ example: 'Lagos' })
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  city: string;

  @ApiProperty({ example: 'Lagos' })
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  region: string;

  @ApiProperty({ example: 'Ikorodu' })
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  lga: string;

  @ApiProperty({ example: 'Nigeria' })
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

/** Body for `POST /api/profile/addresses`. */
export class CreateDeliveryAddressDto extends DeliveryAddressInputDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'Make this the address served to approved purchases (the first saved address always is)',
  })
  @IsOptional()
  @IsBoolean()
  setAsDefault?: boolean;
}

/** A saved address returned to its owner. */
export class SavedAddressDto extends DeliveryAddressInputDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({
    example: true,
    description: 'The address included in payment instructions by default',
  })
  isDefault: boolean;
}

/** Response for `DELETE /api/profile/addresses/:id`. */
export class DeleteAddressResponseDto {
  @ApiProperty({ example: true })
  deleted: true;

  @ApiProperty({ format: 'uuid' })
  id: string;
}

export class DeliveryRecipientDto {
  name: string;
  @ApiProperty({ type: String, nullable: true })
  phone: string | null;
}

export interface DeliveryContext {
  deliveryAddress: SavedAddressDto | null;
  recipient: DeliveryRecipientDto;
}

export const deliveryAddressSelect = {
  id: true,
  recipientName: true,
  recipientPhone: true,
  street: true,
  addressLine2: true,
  city: true,
  region: true,
  lga: true,
  country: true,
  postalCode: true,
  isDefault: true,
} as const;
