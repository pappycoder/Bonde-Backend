import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KYC_PROVIDER, KycProviderError } from '../src/modules/kyc/kyc.types.js';
import {
  bootE2EApp,
  SEED_OTHER_ID,
  SEED_USER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

describe('Identity verification mobile contract (local database, stub provider)', () => {
  let ctx: BootedE2EApp;
  let outcome: 'verified' | 'failed' | 'unavailable';
  beforeEach(async () => {
    outcome = 'verified';
    ctx = await bootE2EApp({
      overrides: [
        {
          token: KYC_PROVIDER,
          useValue: {
            verifyBvn: async () => {
              if (outcome === 'unavailable')
                throw new KycProviderError('CONFIG', 'Verification temporarily unavailable');
              return { verified: outcome === 'verified', reference: 'test-reference' };
            },
          },
        },
      ],
    });
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
  });
  afterEach(async () => {
    await ctx.close();
  });
  it('persists verified status, updates profile reads, and isolates accounts', async () => {
    const body = { bvn: '12345678901', nin: '98765432109' };
    const result = await ctx.http.post('/kyc/verify').send(body).expect(200);
    expect(result.body).toMatchObject({
      status: 'VERIFIED',
      bvnVerified: true,
      ninVerified: false,
      identityVerified: true,
    });
    expect((await ctx.http.get('/profile').expect(200)).body.identityVerified).toBe(true);
    const stored = await ctx.prisma.kycVerification.findUniqueOrThrow({
      where: { userId: SEED_USER_ID },
    });
    expect(stored.bvnHash).not.toContain(body.bvn);
    expect(stored.ninHash).not.toContain(body.nin);
    ctx.setPrincipal({ userId: SEED_OTHER_ID });
    expect((await ctx.http.get('/kyc').expect(200)).body.identityVerified).toBe(false);
  });
  it('returns an explicit failed result without claiming a verified identity', async () => {
    outcome = 'failed';
    const result = await ctx.http
      .post('/kyc/verify')
      .send({ bvn: '12345678901', nin: '98765432109' })
      .expect(200);
    expect(result.body).toMatchObject({ status: 'FAILED', identityVerified: false });
    expect((await ctx.http.get('/profile').expect(200)).body.identityVerified).toBe(false);
  });
  it('validates inputs and reports provider outages without success', async () => {
    await ctx.http.post('/kyc/verify').send({ bvn: '123', nin: '98765432109' }).expect(400);
    outcome = 'unavailable';
    await ctx.http.post('/kyc/verify').send({ bvn: '12345678901', nin: '98765432109' }).expect(503);
    expect((await ctx.http.get('/kyc').expect(200)).body.identityVerified).toBe(false);
  });
});
