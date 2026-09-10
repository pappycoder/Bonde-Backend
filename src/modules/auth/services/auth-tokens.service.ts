import { UnauthorizedException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { CacheService } from '../../../common/cache/cache.service.js';
import type { AppConfig } from '../../../config/configuration.js';

const TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_TTL_CLAIM = '900s';
type TokenPurpose = 'registration' | 'reset';

function nonceKey(purpose: TokenPurpose, jti: string): string {
  return `auth:nonce:${purpose}:${jti}`;
}

/**
 * Short-lived, single-purpose tokens issued by this API to carry a verified
 * email/OTP through to the next step (registration → verify-email,
 * verify-reset-otp → reset-password). NOT Supabase JWTs — these are HS256
 * signed with `AUTH_TOKEN_SECRET` and never reach the `SupabaseAuthGuard`.
 *
 * Single-use is enforced via a Redis nonce (`jti`). `verifyX` only *checks*
 * that the nonce is still present; the caller revokes it with `consumeX` only
 * after the whole step succeeded — so a wrong OTP attempt never burns the
 * token. If Redis is down the token is rejected (fail-closed).
 */
@Injectable()
export class AuthTokensService {
  private readonly secret: Uint8Array;

  constructor(
    private readonly cache: CacheService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.secret = new TextEncoder().encode(config.get('auth').tokenSecret);
  }

  async signRegistrationToken(userId: string): Promise<string> {
    return this.sign('registration', userId);
  }

  async signResetToken(userId: string): Promise<string> {
    return this.sign('reset', userId);
  }

  /** Validate the token without revoking it. */
  async verifyRegistrationToken(token: string): Promise<string> {
    return (await this.validate('registration', token)).sub;
  }

  /** Validate the token without revoking it. */
  async verifyResetToken(token: string): Promise<string> {
    return (await this.validate('reset', token)).sub;
  }

  /** Validate + revoke — call only after the protected step succeeded. */
  async consumeRegistrationToken(token: string): Promise<string> {
    const { sub, jti } = await this.validate('registration', token);
    await this.cache.del(nonceKey('registration', jti));
    return sub;
  }

  /** Validate + revoke — call only after the protected step succeeded. */
  async consumeResetToken(token: string): Promise<string> {
    const { sub, jti } = await this.validate('reset', token);
    await this.cache.del(nonceKey('reset', jti));
    return sub;
  }

  private async sign(purpose: TokenPurpose, userId: string): Promise<string> {
    const jti = randomUUID();
    const key = nonceKey(purpose, jti);

    const token = await new SignJWT({ purpose })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime(TOKEN_TTL_CLAIM)
      .sign(this.secret);

    // Stamp the nonce only after a valid token was produced.
    await this.cache.set(key, userId, TOKEN_TTL_MS);
    return token;
  }

  private async validate(
    purpose: TokenPurpose,
    token: string,
  ): Promise<{ sub: string; jti: string }> {
    let subject: string;
    let jti: string;
    try {
      const { payload } = await jwtVerify(token, this.secret);
      if (payload.purpose !== purpose || typeof payload.sub !== 'string') {
        throw new Error('wrong purpose');
      }
      subject = payload.sub;
      jti = typeof payload.jti === 'string' ? payload.jti : '';
      if (!jti) throw new Error('missing jti');
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const nonce = await this.cache.get<string>(nonceKey(purpose, jti));
    if (nonce !== subject) {
      throw new UnauthorizedException('Token already used or revoked');
    }
    return { sub: subject, jti };
  }
}
