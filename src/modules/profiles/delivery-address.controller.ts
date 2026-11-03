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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { ActivityService } from '../activity/activity.service.js';
import {
  CreateDeliveryAddressDto,
  DeleteAddressResponseDto,
  DeliveryAddressInputDto,
  SavedAddressDto,
} from './delivery-address.dto.js';
import { DeliveryAddressService } from './delivery-address.service.js';

/**
 * Self-service saved delivery addresses. Users keep several destinations, each with
 * its own recipient contact; the default row is what approved purchases receive.
 */
@ApiTags('profiles')
@ApiBearerAuth('access-token')
@Controller('profile/addresses')
export class DeliveryAddressController {
  constructor(
    private readonly addresses: DeliveryAddressService,
    private readonly activity: ActivityService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List your saved delivery addresses (default first)' })
  @ApiOkResponse({ type: [SavedAddressDto] })
  @ApiErrorResponse()
  list(@CurrentUser() principal: AuthPrincipal) {
    return this.addresses.list(principal.userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Save a new delivery address' })
  @ApiCreatedResponse({ type: SavedAddressDto })
  @ApiErrorResponse()
  async create(@CurrentUser() principal: AuthPrincipal, @Body() dto: CreateDeliveryAddressDto) {
    const address = await this.addresses.create(principal.userId, dto);
    await this.activity.record({
      userId: principal.userId,
      action: 'profile.delivery_address.create',
      entityType: 'profile',
      entityId: principal.userId,
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Address saved',
        content: 'A new delivery address was added to your saved addresses.',
      },
    });
    return address;
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update one of your saved delivery addresses' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SavedAddressDto })
  @ApiErrorResponse()
  async update(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DeliveryAddressInputDto,
  ) {
    const address = await this.addresses.update(principal.userId, id, dto);
    await this.activity.record({
      userId: principal.userId,
      action: 'profile.delivery_address.update',
      entityType: 'profile',
      entityId: principal.userId,
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Address updated',
        content: 'One of your saved delivery addresses was updated.',
      },
    });
    return address;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a saved delivery address' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: DeleteAddressResponseDto })
  @ApiErrorResponse()
  async remove(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const result = await this.addresses.remove(principal.userId, id);
    await this.activity.record({
      userId: principal.userId,
      action: 'profile.delivery_address.delete',
      entityType: 'profile',
      entityId: principal.userId,
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Address removed',
        content: 'One of your saved delivery addresses was removed.',
      },
    });
    return result;
  }

  @Post(':id/default')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Make a saved address the default for purchases' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SavedAddressDto })
  @ApiErrorResponse()
  async makeDefault(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const address = await this.addresses.makeDefault(principal.userId, id);
    await this.activity.record({
      userId: principal.userId,
      action: 'profile.delivery_address.default',
      entityType: 'profile',
      entityId: principal.userId,
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Default address updated',
        content: 'Your saved delivery addresses now have a new default.',
      },
    });
    return address;
  }
}
