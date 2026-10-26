import { CanActivate, ConflictException, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';

/** Live financial commands cannot enter the legacy development/Flutterwave write paths. */
@Injectable()
export class FinanceLegacyGuard implements CanActivate {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}
  canActivate(context: ExecutionContext) {
    if (!this.config.get('finance').enabled && this.config.get('nodeEnv') !== 'production')
      return true;
    const req = context.switchToHttp().getRequest<{ method: string; path: string }>();
    const path = req.path.replace(/^\/api/, '');
    if (
      req.method === 'GET' &&
      (/^\/wallet\/deposit-account$/.test(path) || /^\/cards\/[^/]+\/credentials$/.test(path))
    )
      throw new ConflictException('Use the live finance flow for this action');
    if (
      req.method !== 'GET' &&
      (/^\/(cards|transactions|approvals|account)(\/|$)/.test(path) ||
        path === '/wallet' ||
        /^\/wallet\/(withdrawals|deposit-account|banks|resolve-account|bank-accounts)/.test(path))
    ) {
      throw new ConflictException('Use the live finance flow for this action');
    }
    return true;
  }
}
