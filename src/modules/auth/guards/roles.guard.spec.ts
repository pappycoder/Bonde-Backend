import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { RolesGuard } from './roles.guard.js';
import type { AuthPrincipal, BondeRole } from '../principal/auth-principal.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';

function principal(role: BondeRole): AuthPrincipal {
  return {
    userId: 'u-1',
    email: 'a@b.dev',
    phone: null,
    role,
    appMetadata: {},
    userMetadata: {},
  };
}

function makeContext(user?: AuthPrincipal) {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as never;
}

describe('RolesGuard', () => {
  let getMetadata: ReturnType<typeof vi.fn<(key: string) => unknown>>;

  beforeEach(() => {
    getMetadata = vi.fn<(key: string) => unknown>();
  });

  function makeGuard() {
    return new RolesGuard({
      getAllAndOverride: (key: string) => getMetadata(key),
    } as never);
  }

  it('allows public routes regardless of roles', () => {
    getMetadata.mockImplementation((key: string) => key === IS_PUBLIC_KEY);
    expect(makeGuard().canActivate(makeContext(principal('USER')))).toBe(true);
  });

  it('allows any authenticated user when no @Roles is set', () => {
    getMetadata.mockImplementation(() => undefined);
    expect(makeGuard().canActivate(makeContext(principal('USER')))).toBe(true);
  });

  it('rejects a user below the required role', () => {
    getMetadata.mockImplementation((key: string) =>
      key === ROLES_KEY ? (['ADMIN'] as BondeRole[]) : undefined,
    );
    expect(() => makeGuard().canActivate(makeContext(principal('USER')))).toThrow(
      ForbiddenException,
    );
  });

  it('allows a user matching the required role', () => {
    getMetadata.mockImplementation((key: string) =>
      key === ROLES_KEY ? (['ADMIN'] as BondeRole[]) : undefined,
    );
    expect(makeGuard().canActivate(makeContext(principal('ADMIN')))).toBe(true);
  });

  it('allows a superior role to satisfy a lower requirement', () => {
    getMetadata.mockImplementation((key: string) =>
      key === ROLES_KEY ? (['ADMIN'] as BondeRole[]) : undefined,
    );
    expect(makeGuard().canActivate(makeContext(principal('SUPER_ADMIN')))).toBe(true);
  });

  it('allows user-level endpoints for every authenticated role', () => {
    getMetadata.mockImplementation((key: string) =>
      key === ROLES_KEY ? (['USER'] as BondeRole[]) : undefined,
    );
    expect(makeGuard().canActivate(makeContext(principal('USER')))).toBe(true);
    expect(makeGuard().canActivate(makeContext(principal('ADMIN')))).toBe(true);
    expect(makeGuard().canActivate(makeContext(principal('SUPER_ADMIN')))).toBe(true);
  });

  it('rejects an admin who lacks the super-admin requirement', () => {
    getMetadata.mockImplementation((key: string) =>
      key === ROLES_KEY ? (['SUPER_ADMIN'] as BondeRole[]) : undefined,
    );
    expect(() => makeGuard().canActivate(makeContext(principal('ADMIN')))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects role-protected routes without an authenticated principal', () => {
    getMetadata.mockImplementation((key: string) =>
      key === ROLES_KEY ? (['ADMIN'] as BondeRole[]) : undefined,
    );
    expect(() => makeGuard().canActivate(makeContext())).toThrow(ForbiddenException);
  });
});
