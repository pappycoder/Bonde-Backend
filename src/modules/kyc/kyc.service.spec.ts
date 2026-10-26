import { describe, expect, it } from 'vitest';
import { KycService } from './kyc.service.js';
describe('Safe Haven identity status', () => {
  const setup = (bankStatus: string, provider = 'safe-haven') =>
    new KycService({
      financeCustomer: {
        findUnique: async () => ({ bankStatus, identityHash: 'current-identity' }),
      },
      kycVerification: {
        findUnique: async () => ({
          provider,
          bvnHash: 'current-identity',
          bvnVerifiedAt: new Date(),
          ninHash: 'old-other-identity',
          ninVerifiedAt: new Date(),
        }),
      },
    } as never);
  it('does not import legacy verification as current banking verification', async () => {
    expect(await setup('PENDING', 'historical-provider').status('owner')).toMatchObject({
      identityVerified: false,
      bvnVerified: false,
      ninVerified: false,
    });
  });
  it('exposes the provider-confirmed banking identity without leaking its digest', async () => {
    const status = await setup('READY').status('owner');
    expect(status).toMatchObject({
      status: 'VERIFIED',
      identityVerified: true,
      bvnVerified: true,
      ninVerified: false,
    });
    expect(status).not.toHaveProperty('bvnHash');
  });
});
