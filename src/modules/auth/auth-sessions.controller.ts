import { Controller, Delete, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from './decorators/current-user.decorator.js';
import type { AuthPrincipal } from './principal/auth-principal.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { AuthSessionsService } from './services/auth-sessions.service.js';
import { AuthSessionListResponseDto, RevokeSessionResponseDto } from './auth.dto.js';

/**
 * Self-service device sessions: what the caller is signed in on, and the ability
 * to sign one out. Scoped to `principal.userId` — a session belonging to someone
 * else resolves to 404, never 403.
 */
@ApiTags('auth')
@ApiBearerAuth('access-token')
@Controller('auth/sessions')
export class AuthSessionsController {
  constructor(private readonly sessions: AuthSessionsService) {}

  @Get()
  @ApiOperation({ summary: 'List the devices currently signed in to this account' })
  @ApiOkResponse({ type: AuthSessionListResponseDto })
  @ApiErrorResponse()
  async list(@CurrentUser() user: AuthPrincipal) {
    return { sessions: await this.sessions.list(user) };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Revoke one of this account’s sessions' })
  @ApiOkResponse({ type: RevokeSessionResponseDto })
  @ApiErrorResponse()
  async revoke(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.revoke(user, id);
  }
}
