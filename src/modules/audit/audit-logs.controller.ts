import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { AuditLogDto, ListAuditLogsQueryDto, PagedAuditLogsDto } from './audit-logs.dto.js';
import { AuditLogService } from './audit-log.service.js';

/**
 * Read-only self-service view of the caller's own audit trail. Entries remain
 * append-only — records are immutable and users can never read anyone else's.
 * (Admin-wide auditing is served by the generic CRUD surface.)
 */
@ApiTags('audit-logs')
@ApiBearerAuth('access-token')
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private readonly audit: AuditLogService) {}

  @Get()
  @ApiOperation({ summary: 'List your audit trail (paged, `filter=`, free-text `q`)' })
  @ApiOkResponse({ type: PagedAuditLogsDto })
  @ApiErrorResponse()
  list(@CurrentUser() principal: AuthPrincipal, @Query() query: ListAuditLogsQueryDto) {
    return this.audit.listForUser(principal.userId, {
      q: query.q,
      filter: query.filter,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of your audit entries' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AuditLogDto })
  @ApiErrorResponse()
  get(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.audit.getForUser(principal.userId, id);
  }
}
