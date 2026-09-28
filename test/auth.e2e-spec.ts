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
import { MAIL_SENDER, type MailMessage, type MailSender } from '../src/common/mail/mail.types.js';
import {
  bootE2EApp,
  SEED_USER_EMAIL,
  SEED_USER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

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
process.env.REDIS_URL = 'redis://localhost:6379/10';
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
      sessionId: `sess-${email}`,
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
      sessionId: `sess-${email}`,
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

  async updateUserMetadata(userId: string, metadata: Record<string, unknown>): Promise<void> {
    const fullName = metadata.full_name;
    const entry = [...this.accounts.entries()].find(([, account]) => account.id === userId);
    if (entry && typeof fullName === 'string') {
      entry[1].fullName = fullName;
    }
  }
}

const EMAIL = 'new.user@bonde.app';
const PASSWORD = 'hunter2.secure';

describe('Auth endpoints (e2e)', () => {
  let ctx: BootedE2EApp;
  let sent: OtpSendRequest[];
  let failNextSend: boolean;
  let sentMails: MailMessage[];
  let failNextMail: boolean;
  const provider = new FakeSupabaseAuth();
  const sender: OtpSender = {
    send: async (request) => {
      if (failNextSend) throw new OtpSendError('provider down');
      sent.push(request);
    },
  };
  const mailSender: MailSender = {
    send: async (message) => {
      if (failNextMail) throw new Error('mail down');
      sentMails.push(message);
    },
  };

  beforeEach(async () => {
    sent = [];
    failNextSend = false;
    sentMails = [];
    failNextMail = false;
    provider.clear();
    ctx = await bootE2EApp({
      overrides: [
        { token: SUPABASE_AUTH_BODY, useValue: provider },
        { token: OTP_SENDER, useValue: sender },
        { token: MAIL_SENDER, useValue: mailSender },
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

    const accountAfter = await ctx.prisma.account.findUnique({ where: { userId: profile!.id } });
    expect(accountAfter).not.toBeNull();
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0].to).toBe(EMAIL);
    expect(sentMails[0].subject).toContain('Welcome');
    expect(sentMails[0].html).toContain('Account number');
    expect(sentMails[0].html).toContain(accountAfter!.accountNumber);

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
    expect(again.body).toMatchObject({ status: 'sent' });
    // The account exists but is unverified → a fresh one-time ticket is issued
    // so the mobile client can complete verification without re-registering.
    expect(again.body.registrationToken).toEqual(expect.any(String));
    expect(sent.length).toBeGreaterThan(before);

    const missing = await ctx.raw
      .post('/auth/resend-verification-otp')
      .send({ email: 'nobody@bonde.app' })
      .expect(200);
    expect(missing.body).toEqual({ status: 'sent' });
    expect(missing.body.registrationToken).toBeUndefined();
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

    const resetMail = sentMails.at(-1);
    expect(resetMail).toBeDefined();
    expect(resetMail!.to).toBe(EMAIL);
    expect(resetMail!.subject).toContain('password was changed');

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

  it('verification succeeds even when the welcome email delivery fails', async () => {
    failNextMail = true;
    const reg = await ctx.raw
      .post('/auth/register')
      .send({ fullName: 'New User', email: EMAIL, password: PASSWORD })
      .expect(201);

    const code = lastCode();
    await ctx.raw
      .post('/auth/verify-email')
      .send({ token: reg.body.registrationToken, code })
      .expect(200);
    expect(sentMails).toHaveLength(0);
  });

  it('rejects malformed payloads', async () => {
    const noPassword = await ctx.raw
      .post('/auth/register')
      .send({ fullName: 'New User', email: EMAIL })
      .expect(400);
    expect(noPassword.body.message[0]).toContain('password');
  });
  describe('signed-in security (change-password, sessions, logout)', () => {
    /** Register + verify a fresh account and sign the e2e client in as them. */
    async function signInNewUser(): Promise<string> {
      const reg = await ctx.raw
        .post('/auth/register')
        .send({ fullName: 'New User', email: EMAIL, password: PASSWORD })
        .expect(201);
      const code = lastCode();
      await ctx.raw
        .post('/auth/verify-email')
        .send({ token: reg.body.registrationToken, code })
        .expect(200);
      const userId = provider.accounts.get(EMAIL)!.id;
      ctx.setPrincipal({ userId, email: EMAIL, sessionId: 'current-session' });
      return userId;
    }

    async function seedSession(userId: string, sessionId: string): Promise<string> {
      const id = randomUUID();
      await ctx.prisma.authSession.create({
        data: {
          id,
          userId,
          sessionId,
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          ipAddress: '102.89.34.12',
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      return id;
    }

    it('lists the caller sessions and marks the requesting device as current', async () => {
      const userId = await signInNewUser();
      await seedSession(userId, 'current-session');
      await seedSession(userId, 'other-session');

      const res = await ctx.http.get('/auth/sessions').expect(200);

      expect(res.body.sessions).toHaveLength(2);
      const current = res.body.sessions.find((s: { current: boolean }) => s.current);
      expect(current).toBeDefined();
      expect(current.ipAddress).toBe('102.89.34.12');
      expect(current.userAgent).toContain('Macintosh');
      expect(res.body.sessions.filter((s: { current: boolean }) => !s.current)).toHaveLength(1);
    });

    it("revokes a session, hides it from the list, and 404s another user's", async () => {
      const userId = await signInNewUser();
      await seedSession(userId, 'current-session');
      const otherId = await seedSession(userId, 'other-session');

      const revoked = await ctx.http.delete(`/auth/sessions/${otherId}`).expect(200);
      expect(revoked.body).toEqual({ id: otherId, revoked: true });

      const after = await ctx.http.get('/auth/sessions').expect(200);
      expect(after.body.sessions).toHaveLength(1);
      expect(after.body.sessions[0].current).toBe(true);

      // Another principal cannot probe the id — owned sessions resolve to 404.
      ctx.setPrincipal({ userId: SEED_USER_ID, email: SEED_USER_EMAIL, sessionId: null });
      await ctx.http.delete(`/auth/sessions/${otherId}`).expect(404);
    });

    it('changes the password, revokes other sessions and emails the user', async () => {
      const userId = await signInNewUser();
      await seedSession(userId, 'current-session');
      await seedSession(userId, 'other-session');
      const sentBefore = sentMails.length;

      const wrong = await ctx.http
        .post('/auth/change-password')
        .send({ currentPassword: 'not-the-password', newPassword: 'new.hunter2.secure' })
        .expect(401);
      expect(wrong.body.message[0]).toContain('Current password is incorrect');

      const changed = await ctx.http
        .post('/auth/change-password')
        .send({ currentPassword: PASSWORD, newPassword: 'new.hunter2.secure' })
        .expect(200);
      expect(changed.body).toEqual({ status: 'success', revokedSessions: 1 });

      const remaining = await ctx.http.get('/auth/sessions').expect(200);
      expect(remaining.body.sessions).toHaveLength(1);
      expect(remaining.body.sessions[0].current).toBe(true);

      const mail = sentMails.at(-1);
      expect(mail!.to).toBe(EMAIL);
      expect(mail!.subject).toContain('password was changed');
      expect(mail!.html).toContain('1 other device');
      expect(sentMails.length).toBe(sentBefore + 1);

      // The old password no longer opens a session.
      await ctx.raw.post('/auth/login').send({ email: EMAIL, password: PASSWORD }).expect(401);
      await ctx.raw
        .post('/auth/login')
        .send({ email: EMAIL, password: 'new.hunter2.secure' })
        .expect(200);
    });

    it('rejects a too-short new password with 400', async () => {
      await signInNewUser();
      await ctx.http
        .post('/auth/change-password')
        .send({ currentPassword: PASSWORD, newPassword: 'short' })
        .expect(400);
    });

    it('logs out by revoking the current session', async () => {
      const userId = await signInNewUser();
      await seedSession(userId, 'current-session');

      const res = await ctx.http.post('/auth/logout').expect(200);
      expect(res.body).toEqual({ status: 'signed_out' });

      const row = await ctx.prisma.authSession.findUnique({
        where: { sessionId: 'current-session' },
      });
      expect(row?.revokeReason).toBe('logout');
      expect(row?.revokedAt).not.toBeNull();
    });

    it('refuses to refresh a session the user revoked', async () => {
      const userId = await signInNewUser();
      // The fake provider hands out `sess-<email>` for this account.
      await ctx.prisma.authSession.create({
        data: {
          id: randomUUID(),
          userId,
          sessionId: `sess-${EMAIL}`,
          expiresAt: new Date(Date.now() + 3_600_000),
          revokedAt: new Date(),
          revokeReason: 'user',
        },
      });

      const res = await ctx.raw
        .post('/auth/refresh')
        .send({ refreshToken: `rt-${EMAIL}` })
        .expect(401);
      expect(res.body.message[0]).toContain('revoked');
    });

    it('requires a bearer token for every signed-in security route', async () => {
      await ctx.raw.get('/auth/sessions').expect(401);
      await ctx.raw.post('/auth/logout').expect(401);
      await ctx.raw
        .post('/auth/change-password')
        .send({ currentPassword: PASSWORD, newPassword: 'new.hunter2.secure' })
        .expect(401);
    });
  });
  describe('two-factor (TOTP)', () => {
    /** Register + verify a fresh account and return its id. */
    async function verifiedUser(): Promise<string> {
      const reg = await ctx.raw
        .post('/auth/register')
        .send({ fullName: 'Two Factor', email: EMAIL, password: PASSWORD })
        .expect(201);
      await ctx.raw
        .post('/auth/verify-email')
        .send({ token: reg.body.registrationToken, code: lastCode() })
        .expect(200);
      return provider.accounts.get(EMAIL)!.id;
    }

    /** The current TOTP code for a secret, via the same lib the API uses. */
    async function currentCode(secret: string): Promise<string> {
      const { authenticator } = await import('otplib');
      return authenticator.generate(secret);
    }

    it('reports no second factor by default', async () => {
      const userId = await verifiedUser();
      ctx.setPrincipal({ userId, email: EMAIL, sessionId: 'current-session' });

      const res = await ctx.http.get('/auth/2fa').expect(200);
      expect(res.body).toEqual({ enabled: false, enrolledAt: null, recoveryCodesRemaining: 0 });
    });

    it('enrols through setup -> enable and parks the next login', async () => {
      const userId = await verifiedUser();
      ctx.setPrincipal({ userId, email: EMAIL, sessionId: 'current-session' });

      const setup = await ctx.http.post('/auth/2fa/setup').send({ password: PASSWORD }).expect(200);
      expect(setup.body.otpauthUri).toContain(`secret=${setup.body.secret}`);

      const row = await ctx.prisma.twoFactor.findUnique({ where: { userId } });
      // The secret is never stored in the clear.
      expect(row?.secretEnc).not.toContain(setup.body.secret);
      expect(row?.enabledAt).toBeNull();

      const enabled = await ctx.http
        .post('/auth/2fa/enable')
        .send({ code: await currentCode(setup.body.secret) })
        .expect(200);
      expect(enabled.body.recoveryCodes).toHaveLength(10);

      const status = await ctx.http.get('/auth/2fa').expect(200);
      expect(status.body.enabled).toBe(true);
      expect(status.body.recoveryCodesRemaining).toBe(10);

      // The next password login now returns a challenge instead of tokens.
      const login = await ctx.raw
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      expect(login.body.mfaRequired).toBe(true);
      expect(login.body.challengeId).toBeTruthy();
      expect(login.body.accessToken).toBeUndefined();

      const verified = await ctx.raw
        .post('/auth/login/mfa')
        .send({ challengeId: login.body.challengeId, code: await currentCode(setup.body.secret) })
        .expect(200);
      expect(verified.body.accessToken).toBeTruthy();
      expect(verified.body.refreshToken).toBeTruthy();
    });

    it('400s setup with the wrong password and 401s enable with a bad code', async () => {
      const userId = await verifiedUser();
      ctx.setPrincipal({ userId, email: EMAIL, sessionId: 'current-session' });

      await ctx.http.post('/auth/2fa/setup').send({ password: 'not-the-password' }).expect(401);

      await ctx.http.post('/auth/2fa/setup').send({ password: PASSWORD }).expect(200);
      await ctx.http.post('/auth/2fa/enable').send({ code: '000000' }).expect(401);
      await ctx.http.post('/auth/2fa/enable').send({ code: 'abcdef' }).expect(400);
      const row = await ctx.prisma.twoFactor.findUnique({ where: { userId } });
      expect(row?.enabledAt).toBeNull();
    });

    it('rejects a replayed login challenge', async () => {
      const userId = await verifiedUser();
      ctx.setPrincipal({ userId, email: EMAIL, sessionId: 'current-session' });
      const setup = await ctx.http.post('/auth/2fa/setup').send({ password: PASSWORD }).expect(200);
      await ctx.http
        .post('/auth/2fa/enable')
        .send({ code: await currentCode(setup.body.secret) })
        .expect(200);

      const login = await ctx.raw
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      // Wrong code burns the challenge: a retry with the right one is refused.
      await ctx.raw
        .post('/auth/login/mfa')
        .send({ challengeId: login.body.challengeId, code: '000000' })
        .expect(401);
      await ctx.raw
        .post('/auth/login/mfa')
        .send({ challengeId: login.body.challengeId, code: await currentCode(setup.body.secret) })
        .expect(401);
    });

    it('accepts a recovery code once, then refuses it', async () => {
      const userId = await verifiedUser();
      ctx.setPrincipal({ userId, email: EMAIL, sessionId: 'current-session' });
      const setup = await ctx.http.post('/auth/2fa/setup').send({ password: PASSWORD }).expect(200);
      const enabled = await ctx.http
        .post('/auth/2fa/enable')
        .send({ code: await currentCode(setup.body.secret) })
        .expect(200);
      const recovery = enabled.body.recoveryCodes[0] as string;

      const first = await ctx.raw
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      await ctx.raw
        .post('/auth/login/mfa')
        .send({ challengeId: first.body.challengeId, code: recovery })
        .expect(200);

      const second = await ctx.raw
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      await ctx.raw
        .post('/auth/login/mfa')
        .send({ challengeId: second.body.challengeId, code: recovery })
        .expect(401);
      expect((await ctx.http.get('/auth/2fa').expect(200)).body.recoveryCodesRemaining).toBe(9);
    });

    it('disables with password + code and restores plain login', async () => {
      const userId = await verifiedUser();
      ctx.setPrincipal({ userId, email: EMAIL, sessionId: 'current-session' });
      const setup = await ctx.http.post('/auth/2fa/setup').send({ password: PASSWORD }).expect(200);
      await ctx.http
        .post('/auth/2fa/enable')
        .send({ code: await currentCode(setup.body.secret) })
        .expect(200);

      await ctx.http
        .post('/auth/2fa/disable')
        .send({ password: 'not-the-password', code: await currentCode(setup.body.secret) })
        .expect(401);
      await ctx.http
        .post('/auth/2fa/disable')
        .send({ password: PASSWORD, code: '000000' })
        .expect(401);
      expect(await ctx.prisma.twoFactor.findUnique({ where: { userId } })).not.toBeNull();

      await ctx.http
        .post('/auth/2fa/disable')
        .send({ password: PASSWORD, code: await currentCode(setup.body.secret) })
        .expect(200);
      expect(await ctx.prisma.twoFactor.findUnique({ where: { userId } })).toBeNull();

      const login = await ctx.raw
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      expect(login.body.accessToken).toBeTruthy();
    });

    it('requires a bearer token for every 2fa route', async () => {
      await ctx.raw.get('/auth/2fa').expect(401);
      await ctx.raw.post('/auth/2fa/setup').send({ password: PASSWORD }).expect(401);
      await ctx.raw.post('/auth/2fa/enable').send({ code: '123456' }).expect(401);
      await ctx.raw
        .post('/auth/2fa/disable')
        .send({ password: PASSWORD, code: '123456' })
        .expect(401);
    });
  });
});
