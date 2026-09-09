import { describe, it, expect } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { JwksService } from './jwks.service.js';
import { UnauthorizedException } from '@nestjs/common';

describe('JwksService', () => {
  const KID = 'test-key';

  async function setup() {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = KID;
    const local = createLocalJWKSet({ keys: [jwk] });
    const service = new JwksService(local);
    const signToken = (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256', kid: KID })
        .setSubject('user-123')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
    return { service, signToken };
  }

  it('verifies a valid ES256 token into an AuthPrincipal', async () => {
    const { service, signToken } = await setup();
    const token = await signToken({
      email: 'me@bonde.app',
      phone: '+2348000000000',
      app_metadata: { role: 'ADMIN', avatar: 'x' },
      user_metadata: { full_name: 'Ada' },
    });

    const principal = await service.verify(token);

    expect(principal).toEqual({
      userId: 'user-123',
      email: 'me@bonde.app',
      phone: '+2348000000000',
      role: 'ADMIN',
      appMetadata: { role: 'ADMIN', avatar: 'x' },
      userMetadata: { full_name: 'Ada' },
    });
  });

  it('defaults to USER role when app_metadata.role is absent/unknown', async () => {
    const { service, signToken } = await setup();
    const token = await signToken({ email: 'me@bonde.app' });

    const principal = await service.verify(token);

    expect(principal.role).toBe('USER');
    expect(principal.appMetadata).toEqual({});
  });

  it('swallows missing/optional claims', async () => {
    const { service, signToken } = await setup();
    const token = await signToken({});

    const principal = await service.verify(token);

    expect(principal).toMatchObject({ userId: 'user-123', email: null, phone: null, role: 'USER' });
  });

  it('rejects a token whose payload was tampered with', async () => {
    const { service, signToken } = await setup();
    const good = await signToken({ email: 'a@b.dev' });

    const [header, payload, signature] = good.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        email: 'evil@b.dev',
      }),
    ).toString('base64url');
    const forged = `${header}.${tamperedPayload}.${signature}`;

    await expect(service.verify(forged)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a garbage string', async () => {
    const { service } = await setup();
    await expect(service.verify('not-a-jwt')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
