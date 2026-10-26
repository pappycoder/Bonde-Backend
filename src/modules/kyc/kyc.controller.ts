import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { KycStatusDto } from './kyc.dto.js';
import { KycService } from './kyc.service.js';
@ApiTags('kyc')
@ApiBearerAuth('access-token')
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}
  @Get()
  @ApiOperation({ summary: 'Read your Safe Haven banking identity verification status' })
  @ApiOkResponse({ type: KycStatusDto })
  @ApiErrorResponse()
  status(@CurrentUser() principal: AuthPrincipal) {
    return this.kyc.status(principal.userId);
  }
}
