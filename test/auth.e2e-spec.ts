import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthProviderError,
  SUPABASE_AUTH_BODY,
  type SupabaseAuthGateway,
  type SupabaseUser,
} from '../src/modules/auth/supabase/supabase-auth.client.js';
import {
  OTP_SENDER,
  OtpSendError,
  type OtpSender,
} from '../src/modules/otp/otp-sender.interface.js';
import type { OtpSendRequest } from '../src/modules/otp/otp-sender.interface.js';
import { bootE2EApp, seedBaseFixtures, truncateAll, type BootedE2EApp } from './e2e-app.js';

/**
 * The auth suite runs against its OWN Redis database (db 16) with a generous
 * strict throttle so the per-IP brute-force counters never trip across the many
 * register/resend calls in one window. The Supabase Auth body and the OTP
 * sender are replaced with in-memory fakes — no SaaS credentials are used.
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

interface FakeAccount {
  id: string;
  password: string;
  confirmed: boolean;
  fullName: string;
}

class FakeSupabaseAuth implements SupabaseAuthGateway {
  readonly accounts = new Map<string, FakeAccount>();

  clear(): void {
    this.accounts.clear();
  }

  async signUp(input: {
    email: string;
    password: string;
    fullName: string;
  }): Promise<SupabaseUser> {
    if (this.accounts.has(input.email)) {
      throw new AuthProviderError('USER_EXISTS', 'An account with this email already exists');
    }
    const account: FakeAccount = {
      id: randomUUID(),
      password: input.password,
      confirmed: false,
      fullName: input.fullName,
    };
    this.accounts.set(input.email, account);
    return { id: account.id, email: input.email, phone: null, emailConfirmed: false };
  }

  async signInWithPassword(email: string, password: string) {
    const account = this.accounts.get(email);
    if (!account || account.password !== password) {
      throw new AuthProviderError('INVALID_CREDENTIALS', 'Invalid login credentials');
    }
    if (!account.confirmed) {
      throw new AuthProviderError('EMAIL_NOT_CONFIRMED', 'Email not confirmed');
    }
    return {
      accessToken: `at-${email}`,
      refreshToken: `rt-${email}`,
      expiresIn: 3600,
      user: { id: account.id, email, phone: null, emailConfirmed: true },
    };
  }

  async refresh(refreshToken: string) {
    if (!refreshToken.startsWith('rt-')) {
      throw new AuthProviderError('INVALID_CREDENTIALS', 'Invalid refresh token');
    }
    const email = refreshToken.slice(3);
    const account = this.accounts.get(email);
    if (!account) throw new AuthProviderError('INVALID_CREDENTIALS', 'Invalid refresh token');
    return {
      accessToken: `at2-${email}`,
      refreshToken: `rt2-${email}`,
      expiresIn: 3600,
      user: { id: account.id, email, phone: null, emailConfirmed: true },
    };
  }

  async confirmEmail(userId: string): Promise<void> {
    const entry = [...this.accounts.entries()].find(([, account]) => account.id === userId);
    if (!entry) throw new AuthProviderError('NOT_FOUND', 'User not found');
    entry[1].confirmed = true;
  }

  async setPassword(userId: string, password: string): Promise<void> {
    const entry = [...this.accounts.entries()].find(([, account]) => account.id === userId);
    if (!entry) throw new AuthProviderError('NOT_FOUND', 'User not found');
    entry[1].password = password;
    entry[1].confirmed = true;
  }
}

const EMAIL = 'new.user@bonde.app';
const PASSWORD = 'hunter2.secure';

describe('Auth endpoints (e2e)', () => {
  let ctx: BootedE2EApp;
  let sent: OtpSendRequest[];
  let failNextSend: boolean;
  const provider = new FakeSupabaseAuth();
  const sender: OtpSender = {
    send: async (request) => {
      if (failNextSend) throw new OtpSendError('provider down');
      sent.push(request);
    },
  };

  beforeEach(async () => {
    sent = [];
    failNextSend = false;
    provider.clear();
    ctx = await bootE2EApp({
      overrides: [
        { token: SUPABASE_AUTH_BODY, useValue: provider },
        { token: OTP_SENDER, useValue: sender },
      ],
    });
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

  it('registers with a pending email verification and refuses login until confirmed', async () => {
    const res = await ctx.raw
      .post('/auth/register')
      .send({ fullName: 'New User', email: EMAIL, password: PASSWORD })
      .expect(201);

    expect(res.body.status).toBe('pending');
    expect(typeof res.body.registrationToken).toBe('string');
    expect(sent.at(-1)?.channel).toBe('EMAIL');
    expect(sent.at(-1)?.target).toBe(EMAIL);
    expect(lastCode()).toMatch(/^[0-9]{4}$/);

    const profile = await ctx.prisma.profile.findUnique({ where: { email: EMAIL } });
    expect(profile?.emailVerified).toBe(false);

    const pendingAccount = await ctx.prisma.account.findUnique({ where: { userId: profile!.id } });
    expect(pendingAccount).toBeNull();

    const blocked = await ctx.raw
      .post('/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(403);
    expect(blocked.body.message[0]).toContain('verify your email');
  });

  it('verifies the email then lets the user log in and refresh', async () => {
    const reg = await ctx.raw
      .post('/auth/register')
      .send({ fullName: 'New User', email: EMAIL, password: PASSWORD })
      .expect(201);

    const code = lastCode();
    const verified = await ctx.raw
      .post('/auth/verify-email')
      .send({ token: reg.body.registrationToken, code })
      .expect(200);
    expect(verified.body).toEqual({ verified: true });

    const profile = await ctx.prisma.profile.findUnique({ where: { email: EMAIL } });
    expect(profile?.emailVerified).toBe(true);

    const login = await ctx.raw
      .post('/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);
    expect(login.body.accessToken).toBeTruthy();
    expect(login.body.refreshToken).toBeTruthy();
    expect(login.body.expiresIn).toBeGreaterThan(0);
    expect(login.body.user.email).toBe(EMAIL);

    const account = await ctx.prisma.account.findUnique({
      where: { userId: login.body.user.id },
    });
    expect(account).not.toBeNull();
    expect(account?.accountNumber).toMatch(/^\d{10}$/);
    expect(account?.accountType).toBe('CHECKING');
    const wallet = await ctx.prisma.wallet.findFirst({ where: { accountId: account!.id } });
    expect(wallet).not.toBeNull();
    expect(wallet?.currency).toBe('NGN');

    const refreshed = await ctx.raw
      .post('/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(200);
    expect(refreshed.body.accessToken).toBeTruthy();
  });

  it('409 on a duplicate email registration', async () => {
    await ctx.raw
      .post('/auth/register')
      .send({ fullName: 'New User', email: EMAIL, password: PASSWORD })
      .expect(201);

    const dupe = await ctx.raw
      .post('/auth/register')
      .send({ fullName: 'New User', email: EMAIL, password: PASSWORD })
      .expect(409);
    expect(dupe.body.message[0]).toContain('account with this email already exists');
  });

  it('rejects a wrong code and makes the registration token single-use', async () => {
    const reg = await ctx.raw
      .post('/auth/register')
      .send({ fullName: 'New User', email: EMAIL, password: PASSWORD })
      .expect(201);
    const token = reg.body.registrationToken;
    const code = lastCode();

    const wrong = await ctx.raw
      .post('/auth/verify-email')
      .send({ token, code: code === '0000' ? '1111' : '0000' })
      .expect(400);
    expect(wrong.body.message).toContain('Invalid verification code');

    await ctx.raw.post('/auth/verify-email').send({ token, code }).expect(200);

    const replay = await ctx.raw.post('/auth/verify-email').send({ token, code }).expect(401);
    expect(replay.body.message[0]).toContain('already used');
  });

  it('resends the verification code but never reveals missing accounts', async () => {
    await ctx.raw
      .post('/auth/register')
      .send({ fullName: 'New User', email: EMAIL, password: PASSWORD })
      .expect(201);

    const before = sent.length;
    const again = await ctx.raw
      .post('/auth/resend-verification-otp')
      .send({ email: EMAIL })
      .expect(200);
    expect(again.body).toEqual({ status: 'sent' });
    expect(sent.length).toBeGreaterThan(before);

    const missing = await ctx.raw
      .post('/auth/resend-verification-otp')
      .send({ email: 'nobody@bonde.app' })
      .expect(200);
    expect(missing.body).toEqual({ status: 'sent' });
  });

  it('round-trips forgot-password → verify-reset-otp → reset-password', async () => {
    await ctx.raw
      .post('/auth/register')
      .send({ fullName: 'New User', email: EMAIL, password: PASSWORD })
      .expect(201);

    const sentCount = sent.length;
    const forgot = await ctx.raw.post('/auth/forgot-password').send({ email: EMAIL }).expect(200);
    expect(forgot.body).toEqual({ status: 'sent' });
    expect(sent.length).toBeGreaterThan(sentCount);

    const code = lastCode();
    const invalid = await ctx.raw
      .post('/auth/verify-reset-otp')
      .send({ email: EMAIL, code: code === '0000' ? '1111' : '0000' })
      .expect(400);
    expect(invalid.body.message).toContain('Invalid verification code');

    const otpOk = await ctx.raw
      .post('/auth/verify-reset-otp')
      .send({ email: EMAIL, code })
      .expect(200);
    const resetToken = otpOk.body.resetToken;
    expect(typeof resetToken).toBe('string');

    const reset = await ctx.raw
      .patch('/auth/reset-password')
      .send({ token: resetToken, newPassword: 'new.hunter2.secure' })
      .expect(200);
    expect(reset.body).toEqual({ status: 'success' });

    // Old password is now rejected, the new one works.
    await ctx.raw.post('/auth/login').send({ email: EMAIL, password: PASSWORD }).expect(401);
    const login = await ctx.raw
      .post('/auth/login')
      .send({ email: EMAIL, password: 'new.hunter2.secure' })
      .expect(200);
    expect(login.body.user.email).toBe(EMAIL);

    // The reset token is single-use.
    const replay = await ctx.raw
      .patch('/auth/reset-password')
      .send({ token: resetToken, newPassword: 'third.password.1' })
      .expect(401);
    expect(replay.body.message[0]).toContain('already used');
  });

  it('forgot-password never reveals unknown emails', async () => {
    const res = await ctx.raw
      .post('/auth/forgot-password')
      .send({ email: 'ghost@bonde.app' })
      .expect(200);
    expect(res.body).toEqual({ status: 'sent' });
    expect(sent).toHaveLength(0);
  });

  it('fails closed with 503 when the sender is down (register)', async () => {
    failNextSend = true;
    const res = await ctx.raw
      .post('/auth/register')
      .send({ fullName: 'New User', email: EMAIL, password: PASSWORD })
      .expect(503);
    expect(res.body.message).toContain('Unable to send verification code');

    const stored = await ctx.prisma.otpCode.findFirst({ where: { channel: 'EMAIL' } });
    expect(stored?.used).toBe(true);
  });

  it('rejects malformed payloads', async () => {
    const noPassword = await ctx.raw
      .post('/auth/register')
      .send({ fullName: 'New User', email: EMAIL })
      .expect(400);
    expect(noPassword.body.message[0]).toContain('password');
  });
});
