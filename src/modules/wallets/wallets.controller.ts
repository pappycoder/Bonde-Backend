import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { WalletDto } from './wallets.dto.js';
import { WalletsService } from './wallets.service.js';

@ApiTags('wallets')
@ApiBearerAuth('access-token')
@Controller('wallet')
export class WalletsController {
  constructor(private readonly service: WalletsService) {}
  @Get()
  @ApiOperation({ summary: 'Read your wallet' })
  @ApiOkResponse({ type: WalletDto })
  @ApiErrorResponse()
  get(@CurrentUser() principal: AuthPrincipal) {
    return this.service.get(principal.userId);
  }
}
