import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponse } from '../../common/errors/api-error-response.decorator.js';
import { StrictThrottle } from '../../common/throttling/strict-throttle.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { CreateContactMessageDto, JoinWaitlistDto } from './marketing.dto.js';
import { MarketingService } from './marketing.service.js';

/**
 * Public, unauthenticated write surface consumed by the Bonde website
 * (Bonde-Web). Both routes are `@StrictThrottle()` — they are open to the
 * internet and create rows, so the tight per-IP limit applies.
 */
@ApiTags('public')
@ApiErrorResponse()
@Public()
@Controller()
export class MarketingPublicController {
  constructor(private readonly marketing: MarketingService) {}

  @StrictThrottle()
  @HttpCode(HttpStatus.CREATED)
  @Post('waitlist')
  @ApiOperation({ summary: 'Join the pre-launch waitlist (idempotent per email)' })
  joinWaitlist(@Body() dto: JoinWaitlistDto) {
    return this.marketing.joinWaitlist(dto);
  }

  @StrictThrottle()
  @HttpCode(HttpStatus.CREATED)
  @Post('contact')
  @ApiOperation({ summary: 'Submit a message through the website contact form' })
  createContactMessage(@Body() dto: CreateContactMessageDto) {
    return this.marketing.createContactMessage(dto);
  }
}
