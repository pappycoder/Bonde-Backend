import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { AccountDto } from './accounts.dto.js';
import { AccountsService } from './accounts.service.js';

@ApiTags('accounts')
@ApiBearerAuth('access-token')
@Controller('account')
export class AccountsController {
  constructor(private readonly service: AccountsService) {}
  @Get()
  @ApiOperation({ summary: 'Read your account' })
  @ApiOkResponse({ type: AccountDto })
  @ApiErrorResponse()
  get(@CurrentUser() principal: AuthPrincipal) {
    return this.service.get(principal.userId);
  }
}
