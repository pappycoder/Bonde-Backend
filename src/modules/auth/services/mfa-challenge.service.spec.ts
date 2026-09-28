import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { MfaChallengeService, MFA_CHALLENGE_TTL_SECONDS } from './mfa-challenge.service.js';
import type { RedisClient } from '../../../common/redis/redis-client.interface.js';
import type { SupabaseSession } from '../supabase/supabase-auth.client.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

const SESSION = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresIn: 3600,
  sessionId: 'session-1',
  user: { id: USER_ID, email: 'amina@bonde.app', phone: null, emailConfirmed: true },
} as SupabaseSession;

function makeService() {
  const store = new Map<string, string>();
  const redis = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...args: (string | number)[]) => {
      store.set(key, value);
      void args;
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  } as unknown as RedisClient;

  return { service: new MfaChallengeService(redis), redis, store };
}

describe('MfaChallengeService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parks a session behind a uuid handle with a 5-minute ttl', async () => {
    const { service, redis } = makeService();

    const challengeId = await service.create({ userId: USER_ID, session: SESSION });

    expect(challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(redis.set).toHaveBeenCalledWith(
      `auth:mfa:${challengeId}`,
      JSON.stringify({ userId: USER_ID, session: SESSION }),
      'EX',
      MFA_CHALLENGE_TTL_SECONDS,
    );
  });

  it('hands the parked session back exactly once', async () => {
    const { service } = makeService();
    const challengeId = await service.create({ userId: USER_ID, session: SESSION });

    expect(await service.consume(challengeId)).toEqual({ userId: USER_ID, session: SESSION });
    await expect(service.consume(challengeId)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401s an unknown or already-used handle', async () => {
    const { service } = makeService();
    await expect(service.consume('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('401s a corrupted payload instead of throwing', async () => {
    const { service, store } = makeService();
    const challengeId = '11111111-1111-4111-8111-111111111111';
    store.set(`auth:mfa:${challengeId}`, '{not json');

    await expect(service.consume(challengeId)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('deletes the key on consume so a code cannot be replayed', async () => {
    const { service, redis, store } = makeService();
    const challengeId = await service.create({ userId: USER_ID, session: SESSION });

    await service.consume(challengeId);

    expect(redis.del).toHaveBeenCalledWith(`auth:mfa:${challengeId}`);
    expect(store.size).toBe(0);
  });
});
