import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { AppConfig } from '../config/configuration.js';
import { ROLE_HIERARCHY, type AuthPrincipal, type BondeRole } from './auth-principal.js';

export const JWKS = 'JWKS';

export function jwksFromConfig(config: ConfigService<AppConfig, true>): JWTVerifyGetKey {
  const baseUrl = config.get('supabase').url;
  const jwksUrl = `${baseUrl}/auth/v1/.well-known/jwks.json`;
  return createRemoteJWKSet(new URL(jwksUrl));
}

/**
 * Verifies Supabase access tokens (ES256) against the project's JWKS endpoint,
 * as published at `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`. The remote
 * key set is fetched lazily and cached in-memory by `jose`. For tests, the
 * `JWKS` token can be provided as a different key set (e.g. `createLocalJWKSet`).
 */
@Injectable()
export class JwksService {
  constructor(@Inject(JWKS) private readonly jwks: JWTVerifyGetKey) {}

  async verify(accessToken: string): Promise<AuthPrincipal> {
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(accessToken, this.jwks);
      payload = result.payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    return this.toPrincipal(payload);
  }

  private toPrincipal(payload: JWTPayload): AuthPrincipal {
    const appMetadata = this.record(payload.app_metadata);
    const userMetadata = this.record(payload.user_metadata);
    return {
      userId: typeof payload.sub === 'string' ? payload.sub : '',
      email: typeof payload.email === 'string' ? payload.email : null,
      phone: typeof payload.phone === 'string' ? payload.phone : null,
      role: this.toRole(appMetadata.role),
      appMetadata,
      userMetadata,
    };
  }

  private toRole(value: unknown): BondeRole {
    if (typeof value === 'string' && value in ROLE_HIERARCHY) {
      return value as BondeRole;
    }
    return 'USER';
  }

  private record(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  }
}
