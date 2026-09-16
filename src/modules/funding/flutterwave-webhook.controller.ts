import {
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  Controller,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator.js';
import type { AppConfig } from '../../config/configuration.js';
import { verifyFlutterwaveWebhook } from '../flutterwave/webhook-verifier.js';
import type { FlutterwaveWebhookEvent } from '../flutterwave/flutterwave.types.js';
import { DepositsService } from './deposits.service.js';
import { WithdrawalsService } from './withdrawals.service.js';

/**
 * Flutterwave webhook sink (`POST /api/flutterwave/webhook`). The signature is
 * verified over the raw body before the typed handlers run. Unknown or
 * unactionable events are always acked with 200 — Flutterwave treats anything
 * else as a delivery failure and retries.
 */
@ApiTags('flutterwave')
@ApiExcludeController()
@Controller('flutterwave')
export class FlutterwaveWebhookController {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly deposits: DepositsService,
    private readonly withdrawals: WithdrawalsService,
  ) {}

  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Flutterwave webhook receiver (signed by secret hash)' })
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('flutterwave-signature') signature: string | undefined,
    @Headers('verif-hash') verifHash: string | undefined,
  ) {
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    const secret = this.config.get('flutterwave').webhookSecretHash;
    if (!verifyFlutterwaveWebhook(rawBody, signature, verifHash, secret)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let event: FlutterwaveWebhookEvent;
    try {
      event = JSON.parse(rawBody.toString('utf8')) as FlutterwaveWebhookEvent;
    } catch {
      throw new UnauthorizedException('Invalid webhook body');
    }

    switch (event?.event) {
      case 'charge.completed':
        await this.deposits.handleChargeCompleted(event.data as never);
        break;
      case 'transfer.disburse':
        await this.withdrawals.handleTransferDisburse(event.data as never);
        break;
      case 'transfer.reversal':
        await this.withdrawals.handleTransferReversal(event.data as never);
        break;
      default:
        // `card_transaction` and other events are acked; card spends are synced
        // on-demand via `POST /api/cards/:id/transactions/sync`.
        break;
    }

    return { received: true };
  }
}
