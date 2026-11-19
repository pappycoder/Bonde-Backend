import { describe, expect, it, vi } from 'vitest';
import { parseCardProgrammes, selectCardProgramme } from './card-programmes.js';
import type { FinanceConfig } from './finance.config.js';
import { FinanceService } from './finance.service.js';
import { FinanceCapabilities } from './finance-capabilities.service.js';
import { FinanceWorker } from './finance-worker.service.js';
import { fingerprint } from './finance.types.js';

const programmes = [
  {
    brand: 'Verve',
    issueFee: '2.50',
    fundingSourceId: 'verve-source',
    settlementId: 'verve-account',
  },
  {
    brand: 'MasterCard',
    issueFee: '5.00',
    fundingSourceId: 'mc-source',
    settlementId: 'mc-account',
  },
];
const config = {
  ngnBrand: 'Verve',
  ngnIssueFee: '2.50',
  ngnCardProgrammes: programmes,
} as FinanceConfig;

describe('approved card programmes', () => {
  it('rejects duplicate brands, missing routing and invalid fees', () => {
    expect(parseCardProgrammes('')).toBeUndefined();
    expect(parseCardProgrammes(JSON.stringify(programmes))).toEqual(programmes);
    for (const value of [
      [],
      {},
      [programmes[0], programmes[0]],
      [{ ...programmes[0], brand: 'Other' }],
      [{ ...programmes[0], issueFee: '-1' }],
      [{ ...programmes[0], issueFee: 5 }],
      [{ ...programmes[0], issueFee: '1.001' }],
      [{ ...programmes[0], settlementId: '' }],
      [{ ...programmes[0], secret: 'invalid' }],
    ])
      expect(() => parseCardProgrammes(JSON.stringify(value))).toThrow();
  });
  it('keeps legacy defaults and rejects unconfigured brands', () => {
    expect(selectCardProgramme(config, 'NGN')).toEqual(programmes[0]);
    expect(selectCardProgramme({ ...config, ngnBrand: 'Visa' }, 'NGN')).toEqual(programmes[0]);
    expect(selectCardProgramme(config, 'NGN', 'MasterCard')).toEqual(programmes[1]);
    expect(() => selectCardProgramme(config, 'NGN', 'Visa')).toThrow('not available');
  });
  it('checks the selected fee and binds the brand into passcode proofs', () => {
    const service = new FinanceService(
      {} as never,
      {} as never,
      { assertCurrency: vi.fn() } as never,
      {} as never,
      { get: () => config } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const command = {
      kind: 'ISSUE' as const,
      currency: 'NGN' as const,
      brand: 'MasterCard' as const,
      amount: '0.00',
      fee: '5.00',
    };
    expect(() => service.validate(command)).not.toThrow();
    expect(() => service.validate({ ...command, fee: '2.50' })).toThrow('Fees changed');
    expect(() => service.validate({ ...command, brand: 'Visa' })).toThrow('not available');
    expect(() => service.validate({ ...command, kind: 'PAUSE', fee: '0.00' })).toThrow(
      'only be selected',
    );
    expect(fingerprint(command)).not.toBe(fingerprint({ ...command, brand: 'Verve' }));
  });
  it('publishes enabled choices without exposing settlement routing', () => {
    const c = {
      ...config,
      enabled: true,
      environment: 'sandbox',
      ngnEnabled: true,
      sudoBaseUrl: 'https://api.sandbox.sudo.cards',
      safeHavenBaseUrl: 'https://api.sandbox.safehavenmfb.com',
      sudoKey: 'key',
      sudoBusinessId: 'business',
      sudoWebhookToken: 'token',
      safeHavenClientId: 'client',
      safeHavenIssuer: 'issuer',
      safeHavenPrivateKey: 'private',
      safeHavenBankCode: 'bank',
      treasuryAccountNumber: 'treasury',
      jobToken: 'jobs',
      incomingFeeBearer: 'sender',
      feesVerified: true,
      treasuryVerified: true,
    };
    const capabilities = new FinanceCapabilities({ get: () => c } as never);
    expect(capabilities.view().currencies.NGN.programmes).toEqual([
      { brand: 'Verve', issueFee: '2.50' },
      { brand: 'MasterCard', issueFee: '5.00' },
    ]);
    expect(capabilities.view().currencies.USD.enabled).toBe(false);
    c.ngnEnabled = false;
    expect(capabilities.view().currencies.NGN.programmes).toEqual([]);
  });
  it('uses accepted routing even after the configured programme changes', async () => {
    const sudo = {
      call: vi.fn(async (path: string) => {
        if (path === '/fundingsources/mc-source')
          return {
            type: 'gateway',
            status: 'active',
            jitGateway: {
              authorizeByDefault: false,
              url: 'https://bonde.test/api/finance/webhooks/sudo',
            },
          };
        throw new Error('simulated lost provider response');
      }),
    };
    const worker = new FinanceWorker(
      {
        financeCustomer: { findUniqueOrThrow: vi.fn(async () => ({ sudoId: 'customer' })) },
      } as never,
      {} as never,
      sudo as never,
      {} as never,
      {
        get: (key: string) =>
          key === 'publicUrl'
            ? 'https://bonde.test'
            : { ...config, ngnBrand: 'Visa', ngnCardProgrammes: [] },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const issue = worker as unknown as { issue(op: unknown): Promise<void> };
    await expect(
      issue.issue({
        id: 'operation',
        currency: 'NGN',
        userId: 'owner',
        request: { brand: 'MasterCard', issuanceProgramme: programmes[1] },
      }),
    ).rejects.toThrow();
    expect(sudo.call).toHaveBeenCalledWith(
      '/cards',
      'POST',
      expect.objectContaining({
        brand: 'MasterCard',
        fundingSourceId: 'mc-source',
        debitAccountId: 'mc-account',
      }),
    );
  });
});
