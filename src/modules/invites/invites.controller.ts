import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { StrictThrottle } from '../../common/throttling/strict-throttle.decorator.js';
import { AcceptInviteDto, CreateInviteDto, ListInvitesQuery } from './invites.dto.js';
import { InvitesService } from './invites.service.js';

/**
 * Invitation management for the admin console. Redemption is public and lives
 * on the sibling controller below, so the admin resource stays mounted at
 * exactly `/api/admin/invites` (id, revoke) for the admin UI.
 */
@ApiTags('admin-invites')
@ApiBearerAuth('access-token')
@ApiErrorResponse()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Post()
  @ApiOperation({ summary: 'Issue a single-use invite link (emailed to the invitee)' })
  create(@Body() dto: CreateInviteDto, @CurrentUser() principal: AuthPrincipal) {
    return this.invites.create(dto, principal.userId);
  }

  @Get()
  @ApiOperation({ summary: 'List issued invites with a derived status' })
  list(@Query() query: ListInvitesQuery) {
    return this.invites.list(query);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/revoke')
  @ApiOperation({ summary: 'Revoke a pending invite' })
  revoke(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.invites.revoke(id, principal.userId);
  }
}

/** Public redemption pair: peek at an invite, then accept it. */
@ApiTags('invites')
@ApiErrorResponse()
@Public()
@Controller('auth/invites')
export class InvitesPublicController {
  constructor(private readonly invites: InvitesService) {}

  @Get('accept')
  @ApiOperation({ summary: 'Inspect an invite token (never confirms it existed)' })
  peek(@Query('token') token: string) {
    return this.invites.peek(token);
  }

  @StrictThrottle()
  @HttpCode(HttpStatus.CREATED)
  @Post('accept')
  @ApiOperation({ summary: 'Redeem an invite: set your password and join' })
  accept(@Body() dto: AcceptInviteDto) {
    return this.invites.accept(dto);
  }
}
