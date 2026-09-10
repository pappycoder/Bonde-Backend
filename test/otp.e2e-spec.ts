import { Redis } from 'ioredis';
import { OtpChannel } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OtpSendRequest, OtpSender } from '../src/modules/otp/otp-sender.interface.js';
import { OTP_SENDER, OtpSendError } from '../src/modules/otp/otp-sender.interface.js';
import {
  bootE2EApp,
  SEED_OTHER_PHONE,
  SEED_USER_EMAIL,
  SEED_USER_ID,
  SEED_USER_PHONE,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

/**
 * The whole OTP suite runs against its OWN Redis database (db 15) so the strict
 * throttler counters never collide with suites running on the shared instance.
 * The final test boots a second app with strict limit=1 against a scratch Redis
 * db (14) to prove 429s.
 */
const ORIGINAL_ENV: Record<string, string | undefined> = {
  REDIS_URL: process.env.REDIS_URL,
  THROTTLE_STRICT_LIMIT: process.env.THROTTLE_STRICT_LIMIT,
  THROTTLE_STRICT_TTL: process.env.THROTTLE_STRICT_TTL,
  THROTTLE_STRICT_BLOCK_DURATION: process.env.THROTTLE_STRICT_BLOCK_DURATION,
};
process.env.REDIS_URL = 'redis://localhost:6379/15';
process.env.THROTTLE_STRICT_LIMIT = '1000';
process.env.THROTTLE_STRICT_TTL = '60000';
process.env.THROTTLE_STRICT_BLOCK_DURATION = '60000';

describe('OTP verification (e2e)', () => {
  let ctx: BootedE2EApp;
  let sent: OtpSendRequest[];
  let failNext: boolean;
  const sender: OtpSender = {
    send: async (request) => {
      if (failNext) throw new OtpSendError('provider down');
      sent.push(request);
    },
  };

  beforeEach(async () => {
    sent = [];
    failNext = false;
    ctx = await bootE2EApp({ overrides: [{ token: OTP_SENDER, useValue: sender }] });
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

  function lastCode(): string {
    expect(sent.length).toBeGreaterThan(0);
    return sent.at(-1)!.code;
  }

  it('sends a code to your own phone and stores only a digest', async () => {
    const res = await ctx.http
      .post('/otp/send')
      .send({ channel: OtpChannel.PHONE, target: SEED_USER_PHONE })
      .expect(201);
    expect(res.body).toEqual({ status: 'sent' });
    expect(sent.at(-1)?.target).toBe(SEED_USER_PHONE);
    expect(lastCode()).toMatch(/^[0-9]{4}$/);

    const stored = await ctx.prisma.otpCode.findFirst({ where: { userId: SEED_USER_ID } });
    expect(stored).toBeTruthy();
    expect(stored!.code).not.toContain(lastCode());
    expect(stored!.code).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sends a code to your own email', async () => {
    const res = await ctx.http
      .post('/otp/send')
      .send({ channel: OtpChannel.EMAIL, target: SEED_USER_EMAIL })
      .expect(201);
    expect(res.body.status).toBe('sent');
  });

  it('refuses targets that are not your own', async () => {
    const res = await ctx.http
      .post('/otp/send')
      .send({ channel: OtpChannel.PHONE, target: SEED_OTHER_PHONE })
      .expect(400);
    expect(res.body.message).toContain('Target does not belong to this account');
    expect(sent).toHaveLength(0);
  });

  it('verifies a code and marks the phone verified', async () => {
    await ctx.prisma.profile.update({
      where: { id: SEED_USER_ID },
      data: { phoneVerified: false },
    });

    await ctx.http
      .post('/otp/send')
      .send({ channel: OtpChannel.PHONE, target: SEED_USER_PHONE })
      .expect(201);

    const res = await ctx.http
      .post('/otp/verify')
      .send({ channel: OtpChannel.PHONE, target: SEED_USER_PHONE, code: lastCode() })
      .expect(200);
    expect(res.body).toEqual({ verified: true });

    const profile = await ctx.prisma.profile.findUnique({ where: { id: SEED_USER_ID } });
    expect(profile?.phoneVerified).toBe(true);
  });

  it('rejects a wrong code without flipping verification', async () => {
    await ctx.prisma.profile.update({
      where: { id: SEED_USER_ID },
      data: { phoneVerified: false },
    });
    await ctx.http
      .post('/otp/send')
      .send({ channel: OtpChannel.PHONE, target: SEED_USER_PHONE })
      .expect(201);

    const res = await ctx.http
      .post('/otp/verify')
      .send({ channel: OtpChannel.PHONE, target: SEED_USER_PHONE, code: '0000' })
      .expect(400);
    expect(res.body.message).toContain('Invalid verification code');

    const profile = await ctx.prisma.profile.findUnique({ where: { id: SEED_USER_ID } });
    expect(profile?.phoneVerified).toBe(false);
  });

  it('invalidates earlier codes when a new one is sent', async () => {
    await ctx.http
      .post('/otp/send')
      .send({ channel: OtpChannel.PHONE, target: SEED_USER_PHONE })
      .expect(201);
    const first = lastCode();
    await ctx.http
      .post('/otp/send')
      .send({ channel: OtpChannel.PHONE, target: SEED_USER_PHONE })
      .expect(201);
    const second = lastCode();

    await ctx.http
      .post('/otp/verify')
      .send({ channel: OtpChannel.PHONE, target: SEED_USER_PHONE, code: first })
      .expect(400);
    const ok = await ctx.http
      .post('/otp/verify')
      .send({ channel: OtpChannel.PHONE, target: SEED_USER_PHONE, code: second })
      .expect(200);
    expect(ok.body.verified).toBe(true);
  });

  it('makes codes single-use', async () => {
    await ctx.http
      .post('/otp/send')
      .send({ channel: OtpChannel.PHONE, target: SEED_USER_PHONE })
      .expect(201);
    const code = lastCode();

    await ctx.http
      .post('/otp/verify')
      .send({ channel: OtpChannel.PHONE, target: SEED_USER_PHONE, code })
      .expect(200);
    const second = await ctx.http
      .post('/otp/verify')
      .send({ channel: OtpChannel.PHONE, target: SEED_USER_PHONE, code })
      .expect(400);
    expect(second.body.message).toContain('Invalid verification code');
  });

  it('fails closed with 503 when the provider is down and voids the code', async () => {
    failNext = true;
    const res = await ctx.http
      .post('/otp/send')
      .send({ channel: OtpChannel.PHONE, target: SEED_USER_PHONE })
      .expect(503);
    expect(res.body.message).toContain('Unable to send verification code');
    expect(sent).toHaveLength(0);

    await ctx.http
      .post('/otp/verify')
      .send({ channel: OtpChannel.PHONE, target: SEED_USER_PHONE, code: '1234' })
      .expect(400);
  });

  it('rejects malformed payloads', async () => {
    const badChannel = await ctx.http
      .post('/otp/send')
      .send({ channel: 'SMS', target: SEED_USER_PHONE })
      .expect(400);
    expect(badChannel.body.message[0]).toContain('channel');
  });

  it('blocks repeated sends with 429 on the strict throttler', async () => {
    const scratch = new Redis('redis://127.0.0.1:6379/14');
    try {
      await scratch.flushdb();
    } finally {
      await scratch.quit();
    }

    process.env.REDIS_URL = 'redis://localhost:6379/14';
    process.env.THROTTLE_STRICT_LIMIT = '1';
    process.env.THROTTLE_STRICT_TTL = '60000';
    process.env.THROTTLE_STRICT_BLOCK_DURATION = '60000';

    const strict = await bootE2EApp({ overrides: [{ token: OTP_SENDER, useValue: sender }] });
    try {
      await strict.http
        .post('/otp/send')
        .send({ channel: OtpChannel.PHONE, target: SEED_USER_PHONE })
        .expect(201);
      const blocked = await strict.http
        .post('/otp/send')
        .send({ channel: OtpChannel.PHONE, target: SEED_USER_PHONE })
        .expect(429);
      expect(blocked.body.statusCode).toBe(429);
    } finally {
      await strict.close();
    }
  });
});
