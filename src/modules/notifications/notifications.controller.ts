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
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import {
  ListNotificationsQueryDto,
  MarkAllReadResponseDto,
  NotificationDto,
  PagedNotificationsDto,
  RegisterDeviceDto,
  UnregisterDeviceDto,
  UnregisterDeviceResponseDto,
} from './notifications.dto.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Mobile-facing notification surface, scoped to the authenticated user.
 * Notifications themselves are created internally by other features.
 */
@ApiTags('notifications')
@ApiBearerAuth('access-token')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'List your notifications (paged, `filter=`, free-text `q`)' })
  @ApiOkResponse({ type: PagedNotificationsDto })
  @ApiErrorResponse()
  list(@CurrentUser() principal: AuthPrincipal, @Query() query: ListNotificationsQueryDto) {
    return this.notifications.list(principal.userId, {
      q: query.q,
      filter: query.filter,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark one of your notifications as read' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: NotificationDto })
  @ApiErrorResponse()
  markRead(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.notifications.markRead(principal.userId, id);
  }

  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all of your notifications as read' })
  @ApiOkResponse({ type: MarkAllReadResponseDto })
  @ApiErrorResponse()
  markAllRead(@CurrentUser() principal: AuthPrincipal) {
    return this.notifications.markAllRead(principal.userId);
  }

  @Post('devices')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register your device for push deliveries (FCM token)' })
  @ApiCreatedResponse({ type: RegisterDeviceDto })
  @ApiErrorResponse()
  registerDevice(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: RegisterDeviceDto,
  ) {
    return this.notifications.registerDevice({
      userId: principal.userId,
      token: body.token,
      platform: body.platform ?? 'ANDROID',
    });
  }

  @Delete('devices')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unregister your device from push deliveries' })
  @ApiOkResponse({ type: UnregisterDeviceResponseDto })
  @ApiErrorResponse()
  unregisterDevice(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: UnregisterDeviceDto,
  ) {
    return this.notifications.unregisterDevice(principal.userId, body.token);
  }
}
