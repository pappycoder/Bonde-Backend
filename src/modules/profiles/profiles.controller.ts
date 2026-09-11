import { Body, Controller, Get, HttpCode, HttpStatus, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { ActivityService } from '../activity/activity.service.js';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { ProfileDto, UpdateAvatarDto, UpdateProfileDto } from './profiles.dto.js';
import { ProfilesService } from './profiles.service.js';

@ApiTags('profiles')
@ApiBearerAuth('access-token')
@Controller('profile')
export class ProfilesController {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly activity: ActivityService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get your own profile' })
  @ApiOkResponse({ type: ProfileDto })
  @ApiErrorResponse()
  get(@CurrentUser() principal: AuthPrincipal) {
    return this.profiles.get(principal.userId);
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update your own profile (any subset of fields)' })
  @ApiOkResponse({ type: ProfileDto })
  @ApiErrorResponse()
  async update(@CurrentUser() principal: AuthPrincipal, @Body() dto: UpdateProfileDto) {
    const profile = await this.profiles.update(principal.userId, dto);
    await this.activity.record({
      userId: principal.userId,
      action: 'profile.update',
      entityType: 'profile',
      entityId: principal.userId,
      ipAddress: undefined,
      userAgent: undefined,
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Profile updated',
        content:
          "Your profile details were changed. If this wasn't you, contact support immediately.",
      },
    });
    return profile;
  }

  @Patch('avatar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set your avatar from a `u-<userId>/...` storage path' })
  @ApiOkResponse({ type: ProfileDto })
  @ApiErrorResponse()
  async updateAvatar(@CurrentUser() principal: AuthPrincipal, @Body() dto: UpdateAvatarDto) {
    const profile = await this.profiles.updateAvatar(principal.userId, dto);
    await this.activity.record({
      userId: principal.userId,
      action: 'profile.avatar',
      entityType: 'profile',
      entityId: principal.userId,
      notify: {
        type: NotificationType.SYSTEM,
        title: 'Avatar updated',
        content:
          "Your profile picture was changed. If this wasn't you, contact support immediately.",
      },
    });
    return profile;
  }
}
