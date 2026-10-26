import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import type { Currency } from './finance.types.js';

@Injectable()
export class FinanceCapabilities {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}
  get enabled() {
    return this.config.get('finance').enabled;
  }
  assertEnabled() {
    if (!this.enabled) throw new ServiceUnavailableException('Live finance is not enabled');
  }
  assertCurrency(currency: Currency) {
    this.assertEnabled();
    if (!this.view().currencies[currency].enabled)
      throw new ServiceUnavailableException(`${currency} cards are not available yet`);
  }
  view() {
    const c = this.config.get('finance');
    const environmentValid =
      c.environment === 'production'
        ? c.sudoBaseUrl === 'https://api.sudo.cards' &&
          c.safeHavenBaseUrl === 'https://api.safehavenmfb.com'
        : c.sudoBaseUrl === 'https://api.sandbox.sudo.cards' &&
          c.safeHavenBaseUrl === 'https://api.sandbox.safehavenmfb.com';
    const configured =
      c.enabled &&
      environmentValid &&
      !!c.sudoKey &&
      !!c.sudoBusinessId &&
      !!c.sudoWebhookToken &&
      !!c.safeHavenClientId &&
      !!c.safeHavenIssuer &&
      !!c.safeHavenPrivateKey &&
      !!c.safeHavenBankCode &&
      !!c.treasuryAccountNumber &&
      !!c.jobToken &&
      c.incomingFeeBearer !== 'unknown' &&
      c.feesVerified &&
      c.treasuryVerified;
    const ngn = configured && c.ngnEnabled && !!c.ngnFundingSourceId && !!c.ngnSettlementId;
    // USD stays gated: a rate endpoint is not an executable, guaranteed two-way FX contract.
    return {
      cardControlsVersion: 2,
      normalClosureSupported: false,
      enabled: c.enabled,
      environment: c.environment,
      configured,
      allocationMode: 'SEPARATE',
      currencies: {
        NGN: { enabled: ngn, issueFee: c.ngnIssueFee },
        USD: {
          enabled: false,
          issueFee: c.usdIssueFee,
          reason: 'USD_PROGRAMME_VALIDATION_REQUIRED',
        },
      },
      fx: { enabled: false, reason: 'EXECUTABLE_TWO_WAY_FX_NOT_VERIFIED' },
      withdrawalFee: c.withdrawalFee,
      markup: '0.00',
    };
  }
}
