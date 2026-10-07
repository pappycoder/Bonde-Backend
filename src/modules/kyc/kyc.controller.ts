import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { StrictThrottle } from '../../common/throttling/strict-throttle.decorator.js';
import { KycStatusDto, VerifyKycDto } from './kyc.dto.js';
import { KycService } from './kyc.service.js';

/**
 * Self-service identity verification. The raw BVN/NIN never persist — only
 * keyed digests — and every response is scoped to the authenticated user.
 */
@ApiTags('kyc')
@ApiBearerAuth('access-token')
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  @ApiOperation({ summary: 'Get your identity verification status' })
  @ApiOkResponse({ type: KycStatusDto })
  @ApiErrorResponse()
  status(@CurrentUser() principal: AuthPrincipal) {
    return this.kyc.status(principal.userId);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @StrictThrottle()
  @ApiOperation({ summary: 'Verify your BVN and NIN' })
  @ApiOkResponse({ type: KycStatusDto })
  @ApiErrorResponse()
  verify(@CurrentUser() principal: AuthPrincipal, @Body() dto: VerifyKycDto) {
    return this.kyc.verify(principal.userId, dto);
  }
}
