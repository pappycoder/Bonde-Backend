import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { NotificationType } from '@prisma/client';
import { StrictThrottle } from '../../common/throttling/strict-throttle.decorator.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { ActivityService } from '../activity/activity.service.js';
import {
  CreatePasscodeDto,
  PasscodeStatusDto,
  PasscodeValidDto,
  UpdatePasscodeDto,
  ValidatePasscodeDto,
} from './passcode.dto.js';
import { PasscodeService } from './passcode.service.js';

/**
 * One-time 4-digit passcode secured before the shell is reachable. Stored only
 * as an scrypt digest; validate re-authorizes sensitive mutations (e.g. before
 * transactions) server-side. Writes are strictly throttled.
 */
@ApiTags('passcode')
@ApiBearerAuth('access-token')
@Controller('passcode')
export class PasscodeController {
  constructor(
    private readonly passcode: PasscodeService,
    private readonly activity: ActivityService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Whether the caller has a passcode set' })
  @ApiOkResponse({ type: PasscodeStatusDto })
  @ApiErrorResponse()
  status(@CurrentUser() principal: AuthPrincipal) {
    return this.passcode.getStatus(principal.userId);
  }

  @Post()
  @StrictThrottle()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create your passcode (409 if already set)' })
  @ApiCreatedResponse({ type: PasscodeStatusDto })
  @ApiErrorResponse()
  async create(@CurrentUser() principal: AuthPrincipal, @Body() dto: CreatePasscodeDto) {
    const result = await this.passcode.create(principal.userId, dto.passcode);
    await this.activity.record({
      userId: principal.userId,
      action: 'passcode.create',
      entityType: 'passcode',
      entityId: principal.userId,
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Passcode set',
        content: 'Your passcode is active and protects your transactions.',
      },
    });
    return result;
  }

  @Patch()
  @StrictThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change your passcode (current passcode required)' })
  @ApiOkResponse({ type: PasscodeStatusDto })
  @ApiErrorResponse()
  async update(@CurrentUser() principal: AuthPrincipal, @Body() dto: UpdatePasscodeDto) {
    const result = await this.passcode.update(
      principal.userId,
      dto.currentPasscode,
      dto.newPasscode,
    );
    await this.activity.record({
      userId: principal.userId,
      action: 'passcode.update',
      entityType: 'passcode',
      entityId: principal.userId,
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Passcode changed',
        content: 'Your passcode was updated successfully.',
      },
    });
    return result;
  }

  @Post('validate')
  @StrictThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate a passcode before a sensitive action' })
  @ApiOkResponse({ type: PasscodeValidDto })
  @ApiErrorResponse()
  validate(@CurrentUser() principal: AuthPrincipal, @Body() dto: ValidatePasscodeDto) {
    return this.passcode.validate(principal.userId, dto.passcode);
  }
}
