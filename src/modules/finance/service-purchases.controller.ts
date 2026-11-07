import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiOkResponse,
  ApiCreatedResponse,
} from '@nestjs/swagger';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { StrictThrottle } from '../../common/throttling/strict-throttle.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import {
  ServiceExecuteDto,
  ServiceProofDto,
  ServiceQuoteDto,
  ServiceVerifyDto,
  ServiceQuoteViewDto,
  ServiceOrderViewDto,
  ServiceReminderDto,
} from './service-purchase.dto.js';
import { ServicePurchases } from './service-purchases.service.js';

@ApiTags('service-purchases')
@ApiBearerAuth('access-token')
@ApiErrorResponse()
@Controller('finance/services')
export class ServicePurchasesController {
  constructor(private readonly services: ServicePurchases) {}
  @Get('catalog')
  @ApiOperation({ summary: 'List supported cable and data services' })
  catalog() {
    return this.services.catalog();
  }
  @Get(':serviceId/plans')
  @ApiOperation({ summary: 'Read current provider plan prices' })
  plans(@Param('serviceId') serviceId: string) {
    return this.services.plans(serviceId);
  }
  @Post('verify')
  @StrictThrottle()
  @ApiOperation({ summary: 'Verify a service beneficiary without purchasing' })
  verify(@Body() dto: ServiceVerifyDto) {
    return this.services.verify(dto.serviceId, dto.beneficiary);
  }
  @ApiCreatedResponse({ type: ServiceQuoteViewDto })
  @Post('quotes')
  @StrictThrottle()
  @ApiOperation({ summary: 'Prepare a five-minute service purchase quote' })
  quote(@CurrentUser() user: AuthPrincipal, @Body() dto: ServiceQuoteDto) {
    return this.services.quote(user.userId, dto);
  }
  @Post('proof')
  @StrictThrottle()
  @ApiOperation({ summary: 'Authorize one exact quote with a passcode' })
  proof(@CurrentUser() user: AuthPrincipal, @Body() dto: ServiceProofDto) {
    return this.services.proof(user.userId, dto.quoteId, dto.passcode);
  }
  @ApiCreatedResponse({ type: ServiceOrderViewDto })
  @Post('orders')
  @StrictThrottle()
  @ApiOperation({ summary: 'Reserve wallet funds and submit an authorized service order' })
  execute(@CurrentUser() user: AuthPrincipal, @Body() dto: ServiceExecuteDto) {
    return this.services.execute(user.userId, dto.quoteId, dto.proof, dto.requestKey);
  }
  @ApiOkResponse({ type: ServiceOrderViewDto, isArray: true })
  @Get('orders')
  @ApiOperation({ summary: 'List owned service purchases' })
  orders(@CurrentUser() user: AuthPrincipal) {
    return this.services.orders(user.userId);
  }
  @Get('quotes/:id/order')
  @ApiOperation({ summary: 'Recover a purchase after a lost confirmation response' })
  byQuote(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.services.orderByQuote(user.userId, id);
  }
  @Post('orders/:id/renewal-quote')
  @StrictThrottle()
  @ApiOperation({ summary: 'Read a fresh renewal quote without authorizing payment' })
  renewal(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.services.renewalQuote(user.userId, id);
  }
  @ApiOkResponse({ type: ServiceOrderViewDto })
  @Get('orders/:id')
  @ApiOperation({ summary: 'Read an owned service order and receipt' })
  order(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.services.order(user.userId, id);
  }
  @Get('reminders')
  @ApiOperation({ summary: 'Read renewal reminders' })
  reminders(@CurrentUser() user: AuthPrincipal) {
    return this.services.reminders(user.userId);
  }
  @Post('orders/:id/reminders')
  @ApiOperation({ summary: 'Schedule a reminder without authorizing an automatic payment' })
  reminder(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ServiceReminderDto,
  ) {
    return this.services.reminder(user.userId, id, new Date(dto.dueAt));
  }
  @Delete('reminders/:id')
  @ApiOperation({ summary: 'Cancel a renewal reminder' })
  cancel(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.services.cancelReminder(user.userId, id);
  }
}
