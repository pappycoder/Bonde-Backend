import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootE2EApp,
  SEED_USER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

/**
 * Passcode suite runs on its own Redis DB (16) with a high strict limit so the
 * throttler counters (per-route, per-client) never bleed into other suites and
 * the legitimate write/validate calls never 429.
 */
const ORIGINAL_ENV: Record<string, string | undefined> = {
  REDIS_URL: process.env.REDIS_URL,
  THROTTLE_STRICT_LIMIT: process.env.THROTTLE_STRICT_LIMIT,
  THROTTLE_STRICT_TTL: process.env.THROTTLE_STRICT_TTL,
  THROTTLE_STRICT_BLOCK_DURATION: process.env.THROTTLE_STRICT_BLOCK_DURATION,
};
process.env.REDIS_URL = 'redis://localhost:6379/16';
process.env.THROTTLE_STRICT_LIMIT = '1000';
process.env.THROTTLE_STRICT_TTL = '60000';
process.env.THROTTLE_STRICT_BLOCK_DURATION = '60000';

describe('Passcode (self-service e2e)', () => {
  let ctx: BootedE2EApp;

  beforeEach(async () => {
    ctx = await bootE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
  });

  afterEach(async () => {
    await ctx.close();
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('reports no passcode until one is set', async () => {
    const before = await ctx.http.get('/passcode').expect(200);
    expect(before.body).toEqual({ hasPasscode: false });
  });

  it('creates a passcode and rejects a second one (409)', async () => {
    const created = await ctx.http.post('/passcode').send({ passcode: '1234' }).expect(201);
    expect(created.body).toEqual({ hasPasscode: true });

    const stored = await ctx.prisma.passcode.findUniqueOrThrow({
      where: { userId: SEED_USER_ID },
    });
    expect(stored.hash).not.toBe('1234');
    expect(stored.salt).toMatch(/^[0-9a-f]{32}$/);

    await ctx.http.post('/passcode').send({ passcode: '5678' }).expect(409);
  });

  it('validates the right passcode and rejects a wrong one (401)', async () => {
    await ctx.http.post('/passcode').send({ passcode: '1234' }).expect(201);

    const ok = await ctx.http.post('/passcode/validate').send({ passcode: '1234' }).expect(200);
    expect(ok.body).toEqual({ valid: true });

    await ctx.http.post('/passcode/validate').send({ passcode: '0000' }).expect(401);
  });

  it('requires the current passcode to change it', async () => {
    await ctx.http.post('/passcode').send({ passcode: '1234' }).expect(201);

    const bad = await ctx.http
      .patch('/passcode')
      .send({ currentPasscode: '9999', newPasscode: '5678' })
      .expect(401);
    expect(bad.body.message).toBe('Current passcode is incorrect');

    await ctx.http
      .patch('/passcode')
      .send({ currentPasscode: '1234', newPasscode: '5678' })
      .expect(200);

    await ctx.http.post('/passcode/validate').send({ passcode: '5678' }).expect(200);
  });

  it('rejects 4-digit validation', async () => {
    await ctx.http.post('/passcode').send({ passcode: '12' }).expect(400);
    await ctx.http.post('/passcode').send({ passcode: 'abc1' }).expect(400);
  });

  it('locks after repeated failures', async () => {
    await ctx.http.post('/passcode').send({ passcode: '1234' }).expect(201);
    for (let i = 0; i < 4; i += 1) {
      await ctx.http.post('/passcode/validate').send({ passcode: '9999' }).expect(401);
    }
    await ctx.http
      .post('/passcode/validate')
      .send({ passcode: '9999' })
      .expect(401)
      .expect((res) => {
        expect(res.body.message).toMatch(/locked/);
      });
  });
});
