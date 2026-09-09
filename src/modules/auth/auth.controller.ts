import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from './decorators/current-user.decorator.js';
import type { AuthPrincipal } from './principal/auth-principal.js';
import { AuthPrincipalDto } from './principal/auth-principal.dto.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';

@ApiTags('auth')
@ApiBearerAuth('access-token')
@Controller('auth')
export class AuthController {
  @Get('me')
  @ApiOperation({ summary: 'Return the verified session principal' })
  @ApiOkResponse({ type: AuthPrincipalDto, description: 'The authenticated user' })
  @ApiErrorResponse()
  me(@CurrentUser() user: AuthPrincipal): AuthPrincipal {
    return user;
  }
}
