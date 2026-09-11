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
import { NotificationType } from '@prisma/client';
import { ActivityService } from '../activity/activity.service.js';
import { humanizeLabel } from '../activity/activity-copy.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import {
  CreateThresholdDto,
  ListThresholdsQueryDto,
  PagedThresholdsDto,
  ThresholdDto,
  ThresholdsDeleteResponseDto,
  UpdateThresholdDto,
} from './thresholds.dto.js';
import { ThresholdsService } from './thresholds.service.js';

/**
 * Self-service transaction thresholds — one per type per user. Configured by
 * the user to control warning rules on their own transactions.
 */
@ApiTags('thresholds')
@ApiBearerAuth('access-token')
@Controller('thresholds')
export class ThresholdsController {
  constructor(
    private readonly thresholds: ThresholdsService,
    private readonly activity: ActivityService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List your transaction thresholds (paged)' })
  @ApiOkResponse({ type: PagedThresholdsDto })
  @ApiErrorResponse()
  list(@CurrentUser() principal: AuthPrincipal, @Query() query: ListThresholdsQueryDto) {
    return this.thresholds.list(principal.userId, { page: query.page, pageSize: query.pageSize });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a threshold (one per type, 409 on duplicate)' })
  @ApiCreatedResponse({ type: ThresholdDto })
  @ApiErrorResponse()
  async create(@CurrentUser() principal: AuthPrincipal, @Body() dto: CreateThresholdDto) {
    const threshold = await this.thresholds.create(principal.userId, dto);
    await this.activity.record({
      userId: principal.userId,
      action: 'threshold.create',
      entityType: 'transaction_threshold',
      entityId: threshold.id,
      metadata: { thresholdType: threshold.thresholdType },
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Threshold created',
        content: `A ${humanizeLabel(threshold.thresholdType)} threshold was set at ${threshold.thresholdValue}${
          threshold.isActive ? ' and is active' : ''
        }. You'll be alerted when qualified spending happens.`,
      },
    });
    return threshold;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of your thresholds' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ThresholdDto })
  @ApiErrorResponse()
  get(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.thresholds.get(principal.userId, id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update one of your thresholds (value / isActive)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ThresholdDto })
  @ApiErrorResponse()
  async update(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateThresholdDto,
  ) {
    const threshold = await this.thresholds.update(principal.userId, id, dto);
    await this.activity.record({
      userId: principal.userId,
      action: 'threshold.update',
      entityType: 'transaction_threshold',
      entityId: id,
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Threshold updated',
        content: `Your ${humanizeLabel(threshold.thresholdType)} threshold is now ${threshold.thresholdValue} and ${
          threshold.isActive ? 'active' : 'disabled'
        }.`,
      },
    });
    return threshold;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete one of your thresholds' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ThresholdsDeleteResponseDto })
  @ApiErrorResponse()
  async remove(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const result = await this.thresholds.remove(principal.userId, id);
    await this.activity.record({
      userId: principal.userId,
      action: 'threshold.delete',
      entityType: 'transaction_threshold',
      entityId: id,
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Threshold deleted',
        content: 'Your threshold was removed and will no longer trigger spending alerts.',
      },
    });
    return result;
  }
}
