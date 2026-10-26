import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { ListThresholdsQueryDto, PagedThresholdsDto, ThresholdDto } from './thresholds.dto.js';
import { ThresholdsService } from './thresholds.service.js';

/**
 * Self-service transaction thresholds — one per type per user. Configured by
 * the user to control warning rules on their own transactions.
 */
@ApiTags('thresholds')
@ApiBearerAuth('access-token')
@Controller('thresholds')
export class ThresholdsController {
  constructor(private readonly thresholds: ThresholdsService) {}

  @Get()
  @ApiOperation({ summary: 'List your transaction thresholds (paged, `filter=`, free-text `q`)' })
  @ApiOkResponse({ type: PagedThresholdsDto })
  @ApiErrorResponse()
  list(@CurrentUser() principal: AuthPrincipal, @Query() query: ListThresholdsQueryDto) {
    return this.thresholds.list(principal.userId, {
      q: query.q,
      filter: query.filter,
      page: query.page,
      pageSize: query.pageSize,
    });
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
}
