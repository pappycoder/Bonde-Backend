import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { ListBroadcastsQuery, SendBroadcastDto } from './broadcasts.dto.js';
import { BroadcastsService } from './broadcasts.service.js';

@ApiTags('admin-broadcasts')
@ApiBearerAuth('access-token')
@ApiErrorResponse()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/broadcasts')
export class BroadcastsController {
  constructor(private readonly broadcasts: BroadcastsService) {}

  @Post()
  @ApiOperation({ summary: 'Send an in-app broadcast to every active profile' })
  send(@Body() dto: SendBroadcastDto, @CurrentUser() principal: AuthPrincipal) {
    return this.broadcasts.send(dto, principal.userId);
  }

  @Get()
  @ApiOperation({ summary: 'List previously sent broadcasts (newest first)' })
  @ApiOkResponse({ description: '`{ items, total, page, pageSize, totalPages }`' })
  list(@Query() query: ListBroadcastsQuery) {
    return this.broadcasts.list(query);
  }
}
