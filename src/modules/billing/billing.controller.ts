import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';
import { StrictThrottle } from '../../common/throttling/strict-throttle.decorator.js';
import { BillingConfirmDto, BillingOrderDto } from './billing.dto.js';
import { BillingService } from './billing.service.js';
@ApiBearerAuth()
@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}
  @Get('catalog') catalog() {
    return this.billing.catalog();
  }
  @Get('summary') summary(@CurrentUser() user: AuthPrincipal) {
    return this.billing.summary(user.userId);
  }
  @Get('history') history(@CurrentUser() user: AuthPrincipal) {
    return this.billing.history(user.userId);
  }
  @Post('cancel-subscription') @StrictThrottle() cancel(@CurrentUser() user: AuthPrincipal) {
    return this.billing.cancel(user.userId);
  }
  @Post('orders') @StrictThrottle() create(
    @CurrentUser() user: AuthPrincipal,
    @Body() dto: BillingOrderDto,
  ) {
    return this.billing.create(user.userId, dto);
  }
  @Get('orders/:id') order(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.billing.get(user.userId, id);
  }
  @Post('orders/:id/cancel') @StrictThrottle() cancelOrder(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.billing.cancelOrder(user.userId, id);
  }
  @Post('orders/:id/confirm') @StrictThrottle() confirm(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BillingConfirmDto,
  ) {
    return this.billing.confirm(user.userId, id, dto.passcode);
  }
}
