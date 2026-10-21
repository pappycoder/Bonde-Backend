import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { BillingService } from './billing.service.js';

/** Each replica may run this job: period keys and profile row locks prevent duplicate charges. */
@Injectable()
export class BillingRenewalService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingRenewalService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(private readonly billing: BillingService) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.billing.renewDue();
    } catch {
      this.logger.warn(
        'Billing renewal job failed; pending orders will be reconciled on the next run.',
      );
    } finally {
      this.running = false;
    }
  }
}
