import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { REDIS_CLIENT } from '../../../common/redis/redis.module.js';
import type { RedisClient } from '../../../common/redis/redis-client.interface.js';
import type { SupabaseSession } from '../supabase/supabase-auth.client.js';

/**
 * A login that passed the password check but is waiting for its second factor.
 * The provider session is parked here (never returned to the client) until the
 * authenticator code is verified, so an attacker with only the password cannot
 * mint tokens.
 */
export interface ParkedLogin {
  userId: string;
  session: SupabaseSession;
}

/** 5 minutes is long enough to open an authenticator app, short enough to matter. */
export const MFA_CHALLENGE_TTL_SECONDS = 300;

@Injectable()
export class MfaChallengeService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  private key(challengeId: string): string {
    return `auth:mfa:${challengeId}`;
  }

  /** Parks a verified-password session and returns the handle for it. */
  async create(parked: ParkedLogin): Promise<string> {
    const challengeId = randomUUID();
    await this.redis.set(
      this.key(challengeId),
      JSON.stringify(parked),
      'EX',
      MFA_CHALLENGE_TTL_SECONDS,
    );
    return challengeId;
  }

  /**
   * Fetches and immediately deletes the challenge, so a code can only ever be
   * exchanged once. An expired or unknown handle is indistinguishable to the
   * caller.
   */
  async consume(challengeId: string): Promise<ParkedLogin> {
    const raw = await this.redis.get(this.key(challengeId));
    if (!raw) throw new UnauthorizedException('Sign-in expired. Please start again.');
    await this.redis.del(this.key(challengeId));
    try {
      const parked = JSON.parse(raw) as ParkedLogin;
      if (!parked?.userId || !parked.session) throw new Error('malformed challenge');
      return parked;
    } catch {
      throw new UnauthorizedException('Sign-in expired. Please start again.');
    }
  }
}
