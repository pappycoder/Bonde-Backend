import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { AiFundingDto, AiRateDto, AiThresholdsDto, AiUsageQueryDto } from './ai-monitoring.dto.js';
import { AiMonitoringService } from './ai-monitoring.service.js';

@Controller('admin/ai-usage')
@ApiTags('admin-ai-usage')
@ApiBearerAuth('access-token')
@Roles('ADMIN', 'SUPER_ADMIN')
export class AiMonitoringController {
  constructor(private readonly monitor: AiMonitoringService) {}
  @Get()
  @ApiOperation({ summary: 'Inspect overall and per-user AI consumption and funding estimates' })
  overview(@Query() query: AiUsageQueryDto) {
    return this.monitor.overview(query);
  }
  @Put('settings')
  @ApiOperation({ summary: 'Configure provider warning thresholds and alert recipients' })
  settings(@CurrentUser() actor: AuthPrincipal, @Body() body: AiThresholdsDto) {
    return this.monitor.settings(actor.userId, body);
  }
  @Post('funding')
  @ApiOperation({
    summary: 'Record an opening provider balance or a subsequent top-up; does not transfer money',
  })
  funding(@CurrentUser() actor: AuthPrincipal, @Body() body: AiFundingDto) {
    return this.monitor.funding(actor.userId, body);
  }
  @Post('rates')
  @ApiOperation({ summary: 'Record effective pricing for future request cost estimates' })
  rate(@CurrentUser() actor: AuthPrincipal, @Body() body: AiRateDto) {
    return this.monitor.rate(actor.userId, body);
  }
  @Post('check')
  @ApiOperation({ summary: 'Evaluate thresholds and deliver pending admin alert emails' })
  check() {
    this.monitor.assertEnabled();
    return this.monitor.run();
  }
}
