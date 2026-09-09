import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { SupabaseAuthGuard } from './auth.guard.js';
import type { AuthPrincipal } from './auth-principal.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

const principal: AuthPrincipal = {
  userId: 'u-1',
  email: 'a@b.dev',
  phone: null,
  role: 'USER',
  appMetadata: {},
  userMetadata: {},
};

interface AuthTestRequest {
  headers: Partial<{ authorization: string }>;
  user?: AuthPrincipal;
}

function makeContext(request: AuthTestRequest) {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as never;
}

function makeRequest(): AuthTestRequest {
  return { headers: {} };
}

describe('SupabaseAuthGuard', () => {
  let jwks: { verify: (t: string) => Promise<AuthPrincipal> };
  let getMetadata: ReturnType<typeof vi.fn<(key: string) => unknown>>;

  beforeEach(() => {
    getMetadata = vi.fn<(key: string) => unknown>();
    jwks = { verify: vi.fn(async () => ({ ...principal })) } as never;
  });

  function makeGuard() {
    return new SupabaseAuthGuard(
      { getAllAndOverride: (key: string) => getMetadata(key) } as never,
      jwks as never,
    );
  }

  it('allows public routes without a token', async () => {
    getMetadata.mockImplementation((key: string) => key === IS_PUBLIC_KEY);

    await expect(makeGuard().canActivate(makeContext(makeRequest()))).resolves.toBe(true);
    expect(jwks.verify).not.toHaveBeenCalled();
  });

  it('rejects a missing bearer token', async () => {
    getMetadata.mockImplementation(() => undefined);

    await expect(makeGuard().canActivate(makeContext(makeRequest()))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a non-bearer scheme', async () => {
    getMetadata.mockImplementation(() => undefined);
    const request = makeRequest();
    request.headers.authorization = 'Basic abcdef';

    await expect(makeGuard().canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('attaches the verified principal to the request on success', async () => {
    getMetadata.mockImplementation(() => undefined);
    const request = makeRequest();
    request.headers.authorization = 'Bearer tok';

    await expect(makeGuard().canActivate(makeContext(request))).resolves.toBe(true);
    expect(request.user).toEqual(principal);
  });

  it('surfaces verification failures as unauthorized', async () => {
    getMetadata.mockImplementation(() => undefined);
    jwks.verify = vi.fn(async () => {
      throw new UnauthorizedException('Invalid or expired access token');
    }) as never;
    const request = makeRequest();
    request.headers.authorization = 'Bearer bad';

    await expect(makeGuard().canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
