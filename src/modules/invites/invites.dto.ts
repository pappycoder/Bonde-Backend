import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsStrongPassword,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { BondeRole } from '../auth/principal/auth-principal.js';

export class CreateInviteDto {
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }) =>
    String(value ?? '')
      .trim()
      .toLowerCase(),
  )
  email: string;

  @IsOptional()
  @IsString()
  @Length(2, 255)
  @Transform(({ value }) => String(value ?? '').trim())
  fullName?: string;

  @IsOptional()
  @IsEnum(['USER', 'ADMIN', 'SUPER_ADMIN'])
  role?: BondeRole;
}

export class AcceptInviteDto {
  @IsString()
  @Length(20, 200)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'token must be a valid invite token',
  })
  token: string;

  @IsStrongPassword({ minLength: 12 })
  password: string;

  @IsOptional()
  @IsString()
  @Length(2, 255)
  @Transform(({ value }) => String(value ?? '').trim())
  fullName?: string;
}

export class ListInvitesQuery {
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsEnum(['pending', 'accepted', 'revoked', 'expired'])
  status?: 'pending' | 'accepted' | 'revoked' | 'expired';

  @IsOptional()
  @IsString()
  @MaxLength(254)
  @Transform(({ value }) => String(value ?? '').trim())
  q?: string;
}
