import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsString, IsUUID, Length, Matches, MaxLength, MinLength } from 'class-validator';

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

/** Request body for `POST /api/auth/change-password`. */
export class ChangePasswordDto {
  @ApiProperty({ description: 'The password currently in use', minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword: string;

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

  @ApiProperty({
    required: false,
    description:
      'Fresh single-use token for /verify-email (15 min). Only present when ' +
      'the account exists and its email is still unverified.',
  })
  registrationToken?: string;
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

/** A signed-in device, as returned by `GET /api/auth/sessions`. */
export class AuthSessionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, nullable: true, example: 'Mozilla/5.0 (Macintosh…)' })
  userAgent: string | null;

  @ApiProperty({ type: String, nullable: true, example: '102.89.34.12' })
  ipAddress: string | null;

  @ApiProperty({ example: '2026-09-26T10:04:11.000Z' })
  createdAt: string;

  @ApiProperty({ example: '2026-09-26T18:41:02.000Z' })
  lastUsedAt: string;

  @ApiProperty({ description: 'Expiry of the access token last issued for this session' })
  tokenExpiresAt: string;

  @ApiProperty({ description: 'True when this is the session making the request' })
  current: boolean;
}

/** Response for `GET /api/auth/sessions`. */
export class AuthSessionListResponseDto {
  @ApiProperty({ type: [AuthSessionDto] })
  sessions: AuthSessionDto[];
}

/** Response for `DELETE /api/auth/sessions/:id`. */
export class RevokeSessionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: true })
  revoked: true;
}

/** Response for `POST /api/auth/logout`. */
export class LogoutResponseDto {
  @ApiProperty({ example: 'signed_out' })
  status: 'signed_out';
}

/** `POST /api/auth/login` for an account with a second factor: no tokens yet. */
export class MfaRequiredResponseDto {
  @ApiProperty({ example: true })
  mfaRequired: true;

  @ApiProperty({ format: 'uuid', description: 'Handle for POST /api/auth/login/mfa' })
  challengeId: string;

  @ApiProperty({ example: 300, description: 'Seconds until the challenge expires' })
  expiresIn: number;
}

/** Verifies the second factor and releases the parked session. */
export class VerifyLoginMfaDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  challengeId: string;

  @ApiProperty({
    example: '123456',
    description: '6-digit authenticator code, or a recovery code',
  })
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  code: string;
}

/** Response for `GET /api/auth/2fa`. */
export class TwoFactorStatusResponseDto {
  @ApiProperty({ example: false })
  enabled: boolean;

  @ApiProperty({ type: String, nullable: true, example: '2026-09-26T10:04:11.000Z' })
  enrolledAt: string | null;

  @ApiProperty({ example: 10 })
  recoveryCodesRemaining: number;
}

/**
 * Starts enrolment. The password is re-checked so a hijacked session cannot
 * attach its own authenticator to the account.
 */
export class StartTwoFactorDto {
  @ApiProperty({ description: 'Current password, re-verified against the provider' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password: string;
}

/** Response for `POST /api/auth/2fa/setup`. */
export class TwoFactorSetupResponseDto {
  @ApiProperty({ example: 'JBSWY3DPEHPK3PXP', description: 'Base32 TOTP secret' })
  secret: string;

  @ApiProperty({ example: 'otpauth://totp/Bonde:amina@bonde.app?secret=JBSWY3DPEHPK3PXP' })
  otpauthUri: string;
}

/** Confirms enrolment with a code from the authenticator app. */
export class EnableTwoFactorDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Authenticator codes are 6 digits' })
  code: string;
}

/** Response for `POST /api/auth/2fa/enable`: shown to the user exactly once. */
export class TwoFactorEnableResponseDto {
  @ApiProperty({ type: [String], example: ['K3M4P-R7T2X', 'B9WQD-X2FTR'] })
  recoveryCodes: string[];
}

/** Turns the second factor off: password + a current code, both re-checked. */
export class DisableTwoFactorDto {
  @ApiProperty({ description: 'Current password, re-verified against the provider' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password: string;

  @ApiProperty({ description: 'A current authenticator code, or a recovery code' })
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  code: string;
}
