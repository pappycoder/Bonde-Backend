import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length, MaxLength } from 'class-validator';

/** Trim then lowercase — emails are normalized everywhere in the API. */
const normalizeEmail = ({ value }: { value: unknown }): string =>
  String(value ?? '').trim().toLowerCase();

/** Trim a free-text field, collapsing surrounding whitespace. */
const trim = ({ value }: { value: unknown }): string => String(value ?? '').trim();

export class JoinWaitlistDto {
  @IsEmail()
  @MaxLength(254)
  @Transform(normalizeEmail)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  name?: string;

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
