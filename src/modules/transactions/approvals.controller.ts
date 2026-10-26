import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { ApprovalsService } from './approvals.service.js';
import { ListApprovalsQueryDto } from './transactions.dto.js';

@ApiTags('approvals')
@ApiBearerAuth('access-token')
@ApiErrorResponse()
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}
  @Get()
  @ApiOperation({ summary: 'Read your card authorization approvals' })
  list(@CurrentUser() p: AuthPrincipal, @Query() query: ListApprovalsQueryDto) {
    return this.approvals.list(p.userId, query);
  }
  @Get(':id')
  @ApiOperation({ summary: 'Read one owned card authorization approval' })
  get(@CurrentUser() p: AuthPrincipal, @Param('id') id: string) {
    return this.approvals.get(p.userId, id);
  }
}
