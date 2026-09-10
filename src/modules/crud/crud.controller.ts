import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { AuditLogService } from '../audit/audit-log.service.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { CRUD_RESOURCES } from './crud.registry.js';
import { CrudDeleteResponseDto, CrudListQueryDto, PagedCrudResponseDto } from './crud.dto.js';
import { CrudService } from './crud.service.js';

/**
 * Generic admin data-grid over the registered SAFE tables. Every verb is
 * admin/SUPER_ADMIN only. Excluded tables (profiles, accounts, wallets, cards,
 * transactions, otp_codes) are served by dedicated modules, and `audit-logs`
 * is read-only here.
 */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin')
export class CrudController {
  constructor(
    private readonly crud: CrudService,
    private readonly audit: AuditLogService,
  ) {}

  @Post(':resource')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a row (required fields enforced, others optional)' })
  @ApiParam({ name: 'resource', enum: CRUD_RESOURCES })
  @ApiCreatedResponse({ schema: { type: 'object' }, description: 'The created record' })
  @ApiErrorResponse()
  async create(
    @CurrentUser() principal: AuthPrincipal,
    @Param('resource') resource: string,
    @Body() body: Record<string, unknown>,
  ) {
    const record = (await this.crud.create(resource, body)) as Record<string, unknown>;
    await this.audit.record({
      userId: principal.userId,
      action: 'admin.crud.create',
      entityType: resource,
      entityId: String(record.id ?? ''),
    });
    return record;
  }

  @Get(':resource')
  @ApiOperation({ summary: 'List rows (paged, optional equality filters)' })
  @ApiParam({ name: 'resource', enum: CRUD_RESOURCES })
  @ApiOkResponse({ type: PagedCrudResponseDto })
  @ApiErrorResponse()
  list(@Param('resource') resource: string, @Query() query: CrudListQueryDto) {
    return this.crud.list(resource, {
      page: query.page,
      pageSize: query.pageSize,
      filters: query.filter,
      orderBy: query.orderBy,
    });
  }

  @Get(':resource/:id')
  @ApiOperation({ summary: 'Get one row by id' })
  @ApiParam({ name: 'resource', enum: CRUD_RESOURCES })
  @ApiOkResponse({ schema: { type: 'object' }, description: 'The record' })
  @ApiErrorResponse()
  get(
    @Param('resource') resource: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.crud.get(resource, id);
  }

  @Patch(':resource/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update one or more fields of a row' })
  @ApiParam({ name: 'resource', enum: CRUD_RESOURCES })
  @ApiOkResponse({ schema: { type: 'object' }, description: 'The updated record' })
  @ApiErrorResponse()
  async update(
    @CurrentUser() principal: AuthPrincipal,
    @Param('resource') resource: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const record = await this.crud.update(resource, id, body);
    await this.audit.record({
      userId: principal.userId,
      action: 'admin.crud.update',
      entityType: resource,
      entityId: id,
    });
    return record;
  }

  @Delete(':resource/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hard-delete a row' })
  @ApiParam({ name: 'resource', enum: CRUD_RESOURCES })
  @ApiOkResponse({ type: CrudDeleteResponseDto })
  @ApiErrorResponse()
  async remove(
    @CurrentUser() principal: AuthPrincipal,
    @Param('resource') resource: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const result = await this.crud.remove(resource, id);
    await this.audit.record({
      userId: principal.userId,
      action: 'admin.crud.delete',
      entityType: resource,
      entityId: id,
    });
    return result;
  }
}
