import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { StrictThrottle } from '../../common/throttling/strict-throttle.decorator.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { SendOtpDto, SendOtpResponseDto, VerifyOtpDto, VerifyOtpResponseDto } from './otp.dto.js';
import { OtpService } from './otp.service.js';

/**
 * App-level OTP flow (phone/email verification). Both routes carry the strict
 * throttler — 5 requests/minute keyed by client, blocking brute-force attempts.
 * Provisioning codes is NOT done here; use the /api/otp/send -> /api/otp/verify
 * pair only.
 */
@ApiTags('otp')
@ApiBearerAuth('access-token')
@Controller('otp')
export class OtpController {
  constructor(private readonly otp: OtpService) {}

  @Post('send')
  @StrictThrottle()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Send a 6-digit code to your own email or phone' })
  @ApiCreatedResponse({ type: SendOtpResponseDto })
  @ApiErrorResponse()
  send(@CurrentUser() principal: AuthPrincipal, @Body() dto: SendOtpDto) {
    return this.otp.send(principal, dto);
  }

  @Post('verify')
  @StrictThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a code you received' })
  @ApiOkResponse({ type: VerifyOtpResponseDto })
  @ApiErrorResponse()
  verify(@CurrentUser() principal: AuthPrincipal, @Body() dto: VerifyOtpDto) {
    return this.otp.verify(principal, dto);
  }
}
