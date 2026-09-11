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
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import {
  BiometricDeviceDto,
  BiometricsDeleteResponseDto,
  CreateBiometricDeviceDto,
  ListBiometricsQueryDto,
  PagedBiometricsDto,
  UpdateBiometricDeviceDto,
} from './biometrics.dto.js';
import { BiometricsService } from './biometrics.service.js';

/**
 * Self-service biometric enrollments. Stores only the verification public key;
 * users manage their own registered devices.
 */
@ApiTags('biometric-devices')
@ApiBearerAuth('access-token')
@Controller('biometric-devices')
export class BiometricsController {
  constructor(
    private readonly biometrics: BiometricsService,
    private readonly activity: ActivityService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List your enrolled biometric devices (paged)' })
  @ApiOkResponse({ type: PagedBiometricsDto })
  @ApiErrorResponse()
  list(@CurrentUser() principal: AuthPrincipal, @Query() query: ListBiometricsQueryDto) {
    return this.biometrics.list(principal.userId, { page: query.page, pageSize: query.pageSize });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Enroll a biometric device (unique per deviceId)' })
  @ApiCreatedResponse({ type: BiometricDeviceDto })
  @ApiErrorResponse()
  async create(@CurrentUser() principal: AuthPrincipal, @Body() dto: CreateBiometricDeviceDto) {
    const device = await this.biometrics.create(principal.userId, dto);
    await this.activity.record({
      userId: principal.userId,
      action: 'biometric.register',
      entityType: 'biometric_device',
      entityId: device.id,
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Biometric enrolled',
        content: `You can now sign in using ${device.biometricType === 'FACE' ? 'Face ID' : 'your fingerprint'} on "${device.deviceName}".`,
      },
    });
    return device;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of your enrolled devices' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: BiometricDeviceDto })
  @ApiErrorResponse()
  get(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.biometrics.get(principal.userId, id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a device (name / isActive)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: BiometricDeviceDto })
  @ApiErrorResponse()
  async update(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateBiometricDeviceDto,
  ) {
    const device = await this.biometrics.update(principal.userId, id, dto);
    await this.activity.record({
      userId: principal.userId,
      action: 'biometric.update',
      entityType: 'biometric_device',
      entityId: id,
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Biometric updated',
        content: `Your biometric device "${device.deviceName}" was updated${device.isActive === false ? ' and is now disabled' : ''}.`,
      },
    });
    return device;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a biometric enrollment' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: BiometricsDeleteResponseDto })
  @ApiErrorResponse()
  async remove(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const result = await this.biometrics.remove(principal.userId, id);
    await this.activity.record({
      userId: principal.userId,
      action: 'biometric.delete',
      entityType: 'biometric_device',
      entityId: id,
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Biometric removed',
        content: 'Your enrolled device was removed. Re-enroll to use biometric sign-in again.',
      },
    });
    return result;
  }
}
