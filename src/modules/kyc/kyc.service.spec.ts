import { describe, expect, it, vi } from 'vitest';
import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { KycService } from './kyc.service.js';
import { KycProviderError, type KycProvider } from './kyc.types.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function makeService(
  options: {
    existing?: Record<string, unknown> | null;
    provider?: Partial<KycProvider>;
  } = {},
) {
  const kycVerification = {
    findUnique: vi.fn(async () => options.existing ?? null),
    upsert: vi.fn(async (args: { create: Record<string, unknown> }) => ({
      ...args.create,
      id: 'row-1',
    })),
  };
  const activity = { record: vi.fn(async () => undefined) };
  const provider: KycProvider = {
    verifyBvn: vi.fn(async () => ({ verified: true, reference: 'bvn-ref' })),
    ...options.provider,
  };
  const config = {
    get: vi.fn(() => ({ provider: 'dojah', hashSecret: 'pepper' })),
  };
  const service = new KycService(
    { kycVerification } as never,
    activity as never,
    provider,
    config as never,
  );
  return { service, kycVerification, activity, provider };
}

describe('KycService.status', () => {
  it('reports all-false PENDING when there is no row', async () => {
    const { service } = makeService();
    await expect(service.status(USER_ID)).resolves.toEqual({
      status: 'PENDING',
      bvnVerified: false,
      ninVerified: false,
      identityVerified: false,
      bvnVerifiedAt: null,
      ninVerifiedAt: null,
    });
  });
});

describe('KycService.verify', () => {
  it('marks VERIFIED and stores keyed BVN + NIN digests (never the raw values)', async () => {
    const { service, kycVerification } = makeService();
    const result = await service.verify(USER_ID, { bvn: '12345678901', nin: '98765432109' });

    expect(result.status).toBe('VERIFIED');
    expect(result.identityVerified).toBe(true);
    const create = kycVerification.upsert.mock.calls[0][0].create;
    expect(create.bvnHash).toMatch(/^[0-9a-f]{64}$/);
    expect(create.ninHash).toMatch(/^[0-9a-f]{64}$/);
    expect(create.bvnHash).not.toContain('12345678901');
    expect(create.ninHash).not.toContain('98765432109');
    // NIN is collected, never verified against the provider.
    expect(create.ninVerifiedAt).toBeNull();
    expect(result.ninVerified).toBe(false);
  });

  it('records FAILED when the BVN does not match but still stores the NIN', async () => {
    const { service, kycVerification } = makeService({
      provider: { verifyBvn: vi.fn(async () => ({ verified: false })) },
    });
    const result = await service.verify(USER_ID, { bvn: '00000000000', nin: '98765432109' });

    expect(result.status).toBe('FAILED');
    expect(result.bvnVerified).toBe(false);
    expect(result.identityVerified).toBe(false);
    const create = kycVerification.upsert.mock.calls[0][0].create;
    expect(create.bvnHash).toBeNull();
    expect(create.ninHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('skips the provider when the BVN is already verified', async () => {
    const { service, provider } = makeService({
      existing: {
        id: 'row-1',
        bvnHash: 'a'.repeat(64),
        ninHash: null,
        bvnVerifiedAt: new Date(),
        ninVerifiedAt: null,
        providerRef: {},
      },
    });
    const result = await service.verify(USER_ID, { bvn: '12345678901', nin: '98765432109' });

    expect(provider.verifyBvn).not.toHaveBeenCalled();
    expect(result.status).toBe('VERIFIED');
    expect(result.identityVerified).toBe(true);
  });

  it('maps a provider CONFIG failure to 503', async () => {
    const { service } = makeService({
      provider: {
        verifyBvn: vi.fn(async () => {
          throw new KycProviderError('CONFIG', 'not configured');
        }),
      },
    });
    await expect(
      service.verify(USER_ID, { bvn: '12345678901', nin: '98765432109' }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('maps a provider network failure to 502', async () => {
    const { service } = makeService({
      provider: {
        verifyBvn: vi.fn(async () => {
          throw new KycProviderError('PROVIDER', 'unreachable');
        }),
      },
    });
    await expect(
      service.verify(USER_ID, { bvn: '12345678901', nin: '98765432109' }),
    ).rejects.toThrow(BadGatewayException);
  });
});
