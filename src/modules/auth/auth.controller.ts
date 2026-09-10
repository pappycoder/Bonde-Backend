import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';
import type { AuthPrincipal } from './principal/auth-principal.js';
import { AuthPrincipalDto } from './principal/auth-principal.dto.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { StrictThrottle } from '../../common/throttling/strict-throttle.decorator.js';
import { AuthService } from './services/auth.service.js';
import {
  ForgotPasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  RegisterResponseDto,
  ResetPasswordDto,
  ResetStatusResponseDto,
  ResendVerificationOtpDto,
  SendStatusResponseDto,
  SessionResponseDto,
  VerifyEmailDto,
  VerifyEmailResponseDto,
  VerifyResetOtpDto,
  VerifyResetOtpResponseDto,
} from './auth.dto.js';

/**
 * BFF auth + session endpoints. Every route here is `@Public()` (no access
 * token yet exists) and carries `@StrictThrottle()` so brute-force / OTP
 * spraying is rate-limited per client. The verified session principal is
 * available on `GET /api/auth/me`.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @Public()
  @StrictThrottle()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register with email + password, then verify via OTP' })
  @ApiCreatedResponse({ type: RegisterResponseDto })
  @ApiErrorResponse()
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('verify-email')
  @Public()
  @StrictThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm an email with the 4-digit code from the register/resend email',
  })
  @ApiOkResponse({ type: VerifyEmailResponseDto })
  @ApiErrorResponse()
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(dto);
  }

  @Post('resend-verification-otp')
  @Public()
  @StrictThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend the email-verification code (always returns sent)' })
  @ApiOkResponse({ type: SendStatusResponseDto })
  @ApiErrorResponse()
  resendVerificationOtp(@Body() dto: ResendVerificationOtpDto) {
    return this.auth.resendVerificationOtp(dto.email);
  }

  @Post('login')
  @Public()
  @StrictThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log in with email + password, returns access/refresh tokens' })
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiErrorResponse()
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Post('refresh')
  @Public()
  @StrictThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a refresh token for a fresh session' })
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiErrorResponse()
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('forgot-password')
  @Public()
  @StrictThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a 4-digit reset code by email (always returns sent)' })
  @ApiOkResponse({ type: SendStatusResponseDto })
  @ApiErrorResponse()
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.email);
  }

  @Post('verify-reset-otp')
  @Public()
  @StrictThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify the reset code and receive a one-time reset token' })
  @ApiOkResponse({ type: VerifyResetOtpResponseDto })
  @ApiErrorResponse()
  verifyResetOtp(@Body() dto: VerifyResetOtpDto) {
    return this.auth.verifyResetOtp(dto);
  }

  @Patch('reset-password')
  @Public()
  @StrictThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a new password (no old password required)' })
  @ApiOkResponse({ type: ResetStatusResponseDto })
  @ApiErrorResponse()
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto);
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Return the verified session principal' })
  @ApiOkResponse({ type: AuthPrincipalDto, description: 'The authenticated user' })
  @ApiErrorResponse()
  me(@CurrentUser() user: AuthPrincipal): AuthPrincipal {
    return user;
  }
}
