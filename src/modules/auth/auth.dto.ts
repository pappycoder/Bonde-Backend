import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

const EMAIL_MAX = 254;

/** Request body for `POST /api/auth/register`. */
export class RegisterDto {
  @ApiProperty({ example: 'Amina Sule' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fullName: string;

  @ApiProperty({ example: 'amina@bonde.app' })
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email: string;

  @ApiProperty({ example: 'hunter2.secure', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}

/** Request body for `POST /api/auth/verify-email`. */
export class VerifyEmailDto {
  @ApiProperty({ description: 'registrationToken from /register' })
  @IsString()
  @MinLength(20)
  token: string;

  @ApiProperty({ example: '4815' })
  @IsString()
  @Length(4, 4)
  @Matches(/^[0-9]{4}$/, { message: 'code must be 4 digits' })
  code: string;
}

/** Request body for `POST /api/auth/resend-verification-otp`. */
export class ResendVerificationOtpDto {
  @ApiProperty({ example: 'amina@bonde.app' })
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email: string;
}

/** Request body for `POST /api/auth/login`. */
export class LoginDto {
  @ApiProperty({ example: 'amina@bonde.app' })
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email: string;

  @ApiProperty({ example: 'hunter2.secure' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;
}

/** Request body for `POST /api/auth/refresh`. */
export class RefreshDto {
  @ApiProperty({ description: 'refresh_token from login/refresh' })
  @IsString()
  @MinLength(20)
  refreshToken: string;
}

/** Request body for `POST /api/auth/forgot-password`. */
export class ForgotPasswordDto {
  @ApiProperty({ example: 'amina@bonde.app' })
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email: string;
}

/** Request body for `POST /api/auth/verify-reset-otp`. */
export class VerifyResetOtpDto {
  @ApiProperty({ example: 'amina@bonde.app' })
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email: string;

  @ApiProperty({ example: '4815' })
  @IsString()
  @Length(4, 4)
  @Matches(/^[0-9]{4}$/, { message: 'code must be 4 digits' })
  code: string;
}

/** Request body for `PATCH /api/auth/reset-password`. */
export class ResetPasswordDto {
  @ApiProperty({ description: 'resetToken from /verify-reset-otp' })
  @IsString()
  @MinLength(20)
  token: string;

  @ApiProperty({ example: 'new.hunter2.secure', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword: string;
}

/** User object included in session responses. */
export class AuthedUserDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ example: 'amina@bonde.app' })
  email: string;

  @ApiProperty({ type: String, nullable: true, example: '+2348000000000' })
  phone: string | null;
}

/** Response for `POST /api/auth/register`. */
export class RegisterResponseDto {
  @ApiProperty({ example: 'pending' })
  status: 'pending';

  @ApiProperty({ description: 'One-time token for /verify-email (15 min)' })
  registrationToken: string;
}

/** Response for `POST /api/auth/verify-email`. */
export class VerifyEmailResponseDto {
  @ApiProperty({ example: true })
  verified: true;
}

/** Response for `POST /api/auth/login` and `POST /api/auth/refresh`. */
export class SessionResponseDto {
  @ApiProperty({ description: 'Supabase JWT — send as Bearer on protected routes' })
  accessToken: string;

  @ApiProperty({ description: 'Exchange via /auth/refresh when the access token expires' })
  refreshToken: string;

  @ApiProperty({ example: 3600 })
  expiresIn: number;

  @ApiProperty({ type: AuthedUserDto })
  user: AuthedUserDto;
}

/** Response for `POST /api/auth/resend-verification-otp` and `/forgot-password`. */
export class SendStatusResponseDto {
  @ApiProperty({ example: 'sent' })
  status: 'sent';
}

/** Response for `PATCH /api/auth/reset-password`. */
export class ResetStatusResponseDto {
  @ApiProperty({ example: 'success' })
  status: 'success';
}

/** Response for `POST /api/auth/verify-reset-otp`. */
export class VerifyResetOtpResponseDto {
  @ApiProperty({ description: 'One-time token for /reset-password (15 min)' })
  resetToken: string;
}

/**
 * Reused for the actor in login/refresh audit entries — kept separate from the
 * response classes purely to keep swagger models meaningful.
 */
export class AuthUserLiteDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ example: 'amina@bonde.app' })
  email: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '+2348000000000' })
  phone: string | null;
}
