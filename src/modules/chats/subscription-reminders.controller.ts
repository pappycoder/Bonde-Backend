import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { IsDateString, IsUUID } from 'class-validator';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { StrictThrottle } from '../../common/throttling/strict-throttle.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { SubscriptionReminders } from './subscription-reminders.service.js';

export class SubscriptionReminderInput {
  @IsUUID('4') messageId!: string;
  @IsUUID('4') subscriptionId!: string;
  @IsDateString() dueAt!: string;
}

class SubscriptionReminderView {
  id!: string;
  messageId!: string;
  subscriptionId!: string;
  serviceId!: string;
  countryCode!: string;
  dueAt!: Date;
  status!: string;
}
class CancelSubscriptionReminderView {
  cancelled!: boolean;
}

@ApiTags('subscription-reminders')
@ApiBearerAuth('access-token')
@Controller('subscription-reminders')
export class SubscriptionRemindersController {
  constructor(private readonly reminders: SubscriptionReminders) {}
  @Post()
  @StrictThrottle()
  @ApiOperation({
    summary:
      'Schedule or replace your reminder for an owned subscription assistance card; never authorizes payment',
  })
  @ApiErrorResponse()
  @ApiCreatedResponse({ type: SubscriptionReminderView })
  schedule(@CurrentUser() p: AuthPrincipal, @Body() input: SubscriptionReminderInput) {
    return this.reminders.schedule(
      p.userId,
      input.messageId,
      input.subscriptionId,
      new Date(input.dueAt),
    );
  }
  @Get()
  @ApiOperation({ summary: 'List your active subscription reminders without using AI credits' })
  @ApiErrorResponse()
  @ApiOkResponse({ type: [SubscriptionReminderView] })
  list(@CurrentUser() p: AuthPrincipal) {
    return this.reminders.list(p.userId);
  }
  @Delete(':id')
  @ApiOperation({
    summary: 'Cancel your subscription reminder; does not cancel the merchant subscription',
  })
  @ApiErrorResponse()
  @ApiOkResponse({ type: CancelSubscriptionReminderView })
  cancel(
    @CurrentUser() p: AuthPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.reminders.cancel(p.userId, id);
  }
}
