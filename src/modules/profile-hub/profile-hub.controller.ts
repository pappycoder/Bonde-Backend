import { EmailChangeService } from './email-change.service.js';
import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { StrictThrottle } from '../../common/throttling/strict-throttle.decorator.js';
import { ProfileHubService } from './profile-hub.service.js';
import {
  ConfirmPasscodeDto,
  EmailChangeDto,
  PreferencesDto,
  SupportRequestDto,
  SupportReplyDto,
} from './preferences.dto.js';

@ApiTags('profile-hub')
@ApiBearerAuth()
@Controller('profile')
export class ProfileHubController {
  constructor(
    private readonly hub: ProfileHubService,
    private readonly email: EmailChangeService,
  ) {}
  @Post('email-change') @StrictThrottle() changeEmail(
    @CurrentUser() user: AuthPrincipal,
    @Headers('authorization') authorization: string,
    @Body() dto: EmailChangeDto,
  ) {
    return this.email.request(
      user.userId,
      authorization.replace(/^Bearer\s+/i, ''),
      dto.email,
      dto.passcode,
    );
  }
  @Post('email-change/sync') @StrictThrottle() syncEmail(@CurrentUser() user: AuthPrincipal) {
    return this.email.sync(user.userId);
  }
  @Get('preferences') preferences(@CurrentUser() user: AuthPrincipal) {
    return this.hub.preferences(user.userId);
  }
  @Patch('preferences') update(@CurrentUser() user: AuthPrincipal, @Body() dto: PreferencesDto) {
    return this.hub.updatePreferences(user.userId, dto);
  }
  @Get('support') tickets(@CurrentUser() user: AuthPrincipal) {
    return this.hub.tickets(user.userId);
  }
  @Post('support') @StrictThrottle() support(
    @CurrentUser() user: AuthPrincipal,
    @Body() dto: SupportRequestDto,
  ) {
    return this.hub.support(user.userId, dto);
  }
  @Get('support/:id') ticket(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.hub.ticket(user.userId, id);
  }
  @Post('support/:id/messages') @StrictThrottle() reply(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SupportReplyDto,
  ) {
    return this.hub.reply(user.userId, id, dto.message);
  }
  @Post('deletion-request') @StrictThrottle() deletion(
    @CurrentUser() user: AuthPrincipal,
    @Body() dto: ConfirmPasscodeDto,
  ) {
    return this.hub.deletionRequest(user.userId, dto.passcode);
  }
}
