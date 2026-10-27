import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

/** Trim then lowercase — emails are normalized everywhere in the API. */
const normalizeEmail = ({ value }: { value: unknown }): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/** Trim a free-text field, collapsing surrounding whitespace. */
const trim = ({ value }: { value: unknown }): string => String(value ?? '').trim();

export class JoinWaitlistDto {
  @IsEmail()
  @MaxLength(254)
  @Transform(normalizeEmail)
  email: string;

  @IsString()
  @Length(1, 255)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  firstName: string;

  @IsString()
  @Length(1, 255)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  lastName: string;

  @IsString()
  @Matches(/^\+?[0-9]{7,15}$/, {
    message: 'phone must contain 7–15 digits and an optional leading +',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/[\s()-]/g, '') : value,
  )
  phone: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Transform(trim)
  source?: string;
}

export class CreateContactMessageDto {
  @IsString()
  @Length(1, 255)
  @Transform(trim)
  name: string;

  @IsEmail()
  @MaxLength(254)
  @Transform(normalizeEmail)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  subject?: string;

  @IsString()
  @Length(1, 4000)
  @Transform(trim)
  message: string;
}
