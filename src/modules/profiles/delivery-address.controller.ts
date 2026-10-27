import type { Response } from 'express';
import { Body, Controller, Get, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { ActivityService } from '../activity/activity.service.js';
import { DeliveryAddressDto } from './delivery-address.dto.js';
import { DeliveryAddressService } from './delivery-address.service.js';

@ApiTags('profiles')
@ApiBearerAuth('access-token')
@Controller('profile/delivery-address')
export class DeliveryAddressController {
  constructor(
    private readonly addresses: DeliveryAddressService,
    private readonly activity: ActivityService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get your saved delivery address, or null when none is saved' })
  @ApiOkResponse({
    schema: { nullable: true, allOf: [{ $ref: '#/components/schemas/DeliveryAddressDto' }] },
  })
  @ApiErrorResponse()
  async get(@CurrentUser() principal: AuthPrincipal, @Res() response: Response) {
    response.json(await this.addresses.get(principal.userId));
  }

  @Put()
  @ApiOperation({ summary: 'Set or replace your default delivery address' })
  @ApiOkResponse({ type: DeliveryAddressDto })
  @ApiErrorResponse()
  async save(@CurrentUser() principal: AuthPrincipal, @Body() dto: DeliveryAddressDto) {
    const address = await this.addresses.save(principal.userId, dto);
    await this.activity.record({
      userId: principal.userId,
      action: 'profile.delivery_address.update',
      entityType: 'profile',
      entityId: principal.userId,
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Delivery address updated',
        content: 'Your default delivery address was updated.',
      },
    });
    return address;
  }
}
