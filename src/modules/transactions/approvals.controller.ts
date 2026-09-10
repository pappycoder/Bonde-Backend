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
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { AuditLogService } from '../audit/audit-log.service.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import {
  ApprovalDto,
  ApprovalsDeleteResponseDto,
  CreateApprovalDto,
  ListApprovalsQueryDto,
  PagedApprovalsDto,
  UpdateApprovalDto,
} from './transactions.dto.js';
import { ApprovalsService } from './approvals.service.js';

/**
 * Self-service approvals surface — the approval trail of the user's own
 * transactions. Writes record decisions for the money-movement workflow; the
 * approver is always the caller.
 */
@ApiTags('approvals')
@ApiBearerAuth('access-token')
@Controller('approvals')
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List approvals on your transactions (paged, optional status filter)' })
  @ApiOkResponse({ type: PagedApprovalsDto })
  @ApiErrorResponse()
  list(@CurrentUser() principal: AuthPrincipal, @Query() query: ListApprovalsQueryDto) {
    return this.approvals.list(principal.userId, {
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Record an approval on one of your transactions (404 if foreign)' })
  @ApiCreatedResponse({ type: ApprovalDto })
  @ApiErrorResponse()
  async create(@CurrentUser() principal: AuthPrincipal, @Body() dto: CreateApprovalDto) {
    const approval = await this.approvals.create(principal.userId, dto);
    await this.audit.record({
      userId: principal.userId,
      action: 'approval.create',
      entityType: 'transaction_approval',
      entityId: approval.id,
      metadata: { transactionId: approval.transactionId },
    });
    return approval;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one approval on your transactions' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ApprovalDto })
  @ApiErrorResponse()
  get(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.approvals.get(principal.userId, id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update an approval on your transactions' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ApprovalDto })
  @ApiErrorResponse()
  async update(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateApprovalDto,
  ) {
    const approval = await this.approvals.update(principal.userId, id, dto);
    await this.audit.record({
      userId: principal.userId,
      action: 'approval.update',
      entityType: 'transaction_approval',
      entityId: id,
    });
    return approval;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an approval on your transactions' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ApprovalsDeleteResponseDto })
  @ApiErrorResponse()
  async remove(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const result = await this.approvals.remove(principal.userId, id);
    await this.audit.record({
      userId: principal.userId,
      action: 'approval.delete',
      entityType: 'transaction_approval',
      entityId: id,
    });
    return result;
  }
}
