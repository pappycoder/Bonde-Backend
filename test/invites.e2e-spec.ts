import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAIL_SENDER, type MailMessage, type MailSender } from '../src/common/mail/mail.types.js';
import {
  AuthProviderError,
  SUPABASE_AUTH_BODY,
  type SupabaseAuthGateway,
  type SupabaseUser,
} from '../src/modules/auth/supabase/supabase-auth.client.js';
import { bootE2EApp, seedBaseFixtures, truncateAll, type BootedE2EApp } from './e2e-app.js';
import { SEED_USER_EMAIL, SEED_USER_ID } from './db.js';

/**
 * Invitations end to end: an ADMIN issues one, the emailed token is redeemed
 * publicly, and the invitee lands with a provisioned account. The Supabase
 * Auth body and the mail sender are in-memory fakes — no SaaS credentials.
 *
 * Runs against its own Redis database (db 11) so throttler counters never leak
 * between suites; the `.env` REDIS_URL is a `rediss://` Upstash URL that has no
 * DB index at all.
 */
process.env.REDIS_URL = 'redis://localhost:6379/11';
// Many accept calls in one window: keep the strict brute-force counter out of
// the way so the suite tests behaviour, not throttling.
process.env.THROTTLE_STRICT_LIMIT = '1000';
process.env.THROTTLE_STRICT_TTL = '60000';
process.env.THROTTLE_STRICT_BLOCK_DURATION = '60000';
class FakeSupabaseAuth implements SupabaseAuthGateway {
  readonly accounts = new Map<string, { id: string; confirmed: boolean; role?: string }>();
  lastSignUp: { email: string; role?: string; emailConfirm?: boolean } | null = null;

  async signUp(input: {
    email: string;
    password: string;
    fullName: string;
    role?: string;
    emailConfirm?: boolean;
  }): Promise<SupabaseUser> {
    if (this.accounts.has(input.email)) {
      throw new AuthProviderError('USER_EXISTS', 'exists');
    }
    const id = randomUUID();
    this.accounts.set(input.email, {
      id,
      confirmed: input.emailConfirm === true,
      role: input.role,
    });
    this.lastSignUp = { email: input.email, role: input.role, emailConfirm: input.emailConfirm };
    return { id, email: input.email, phone: null, emailConfirmed: true };
  }

  async signInWithPassword(): Promise<never> {
    throw new Error('not used');
  }
  async refresh(): Promise<never> {
    throw new Error('not used');
  }
  async confirmEmail(): Promise<void> {}
  async setPassword(): Promise<void> {}
  async updateUserMetadata(): Promise<void> {}
}

class CaptureMail implements MailSender {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/** Pull the raw `token` query value out of the emailed accept link. */
function tokenFrom(html: string): string {
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(html);
  expect(match, 'invite email must carry a token link').not.toBeNull();
  return decodeURIComponent(match![1]!);
}

describe('Admin invites (e2e)', () => {
  let ctx: BootedE2EApp;
  const provider = new FakeSupabaseAuth();
  const mail = new CaptureMail();

  beforeAll(async () => {
    ctx = await bootE2EApp({
      overrides: [
        { token: SUPABASE_AUTH_BODY, useValue: provider },
        { token: MAIL_SENDER, useValue: mail },
      ],
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
    provider.accounts.clear();
    mail.sent.length = 0;
    ctx.role('ADMIN');
  });

  it('issues an invite that only ever stores a token digest', async () => {
    const res = await ctx.http
      .post('/admin/invites')
      .send({ email: 'newhire@bonde.ai', fullName: 'New Hire', role: 'ADMIN' })
      .expect(201);

    expect(res.body).toMatchObject({ email: 'newhire@bonde.ai', role: 'ADMIN', status: 'pending' });
    expect(res.body.tokenHash).toBeUndefined();

    const invite = await ctx.prisma.userInvite.findFirstOrThrow({
      where: { email: 'newhire@bonde.ai' },
    });
    expect(invite.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe('newhire@bonde.ai');
    expect(mail.sent[0]!.html).toContain('/accept-invite?token=');

    const token = tokenFrom(mail.sent[0]!.html);
    expect(invite.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('peeks then accepts: the invitee sets their own password and is provisioned', async () => {
    await ctx.http
      .post('/admin/invites')
      .send({ email: 'newhire@bonde.ai', fullName: 'New Hire', role: 'ADMIN' })
      .expect(201);
    const token = tokenFrom(mail.sent[0]!.html);

    const peek = await ctx.raw.get('/auth/invites/accept').query({ token }).expect(200);
    expect(peek.body).toMatchObject({
      email: 'newhire@bonde.ai',
      fullName: 'New Hire',
      role: 'ADMIN',
      valid: true,
    });

    await ctx.raw
      .post('/auth/invites/accept')
      .send({ token, password: 'Str0ng!Passphrase42' })
      .expect(201);

    const userId = provider.accounts.get('newhire@bonde.ai')!.id;
    // Pre-confirmed (the emailed link is the proof) with the invited role.
    expect(provider.lastSignUp).toMatchObject({ emailConfirm: true, role: 'ADMIN' });

    const profile = await ctx.prisma.profile.findUniqueOrThrow({ where: { id: userId } });
    expect(profile).toMatchObject({ email: 'newhire@bonde.ai', emailVerified: true });
    const account = await ctx.prisma.account.findUniqueOrThrow({ where: { userId } });
    expect(account.accountNumber).toMatch(/^\d{10}$/);
    expect(await ctx.prisma.wallet.count({ where: { accountId: account.id } })).toBe(1);

    const invite = await ctx.prisma.userInvite.findFirstOrThrow({
      where: { email: 'newhire@bonde.ai' },
    });
    expect(invite.acceptedAt).not.toBeNull();
  });

  it('is single-use: a second redemption of the same token fails', async () => {
    await ctx.http.post('/admin/invites').send({ email: 'newhire@bonde.ai' }).expect(201);
    const token = tokenFrom(mail.sent[0]!.html);
    await ctx.raw
      .post('/auth/invites/accept')
      .send({ token, password: 'Str0ng!Passphrase42' })
      .expect(201);

    const replay = await ctx.raw
      .post('/auth/invites/accept')
      .send({ token, password: 'Str0ng!Passphrase42' })
      .expect(400);
    expect(replay.body.message.join(' ')).toContain('no longer valid');
  });

  it('rejects a weak password but leaves the invite usable', async () => {
    await ctx.http.post('/admin/invites').send({ email: 'newhire@bonde.ai' }).expect(201);
    const token = tokenFrom(mail.sent[0]!.html);

    await ctx.raw.post('/auth/invites/accept').send({ token, password: 'short' }).expect(400);
    expect(await ctx.prisma.profile.count({ where: { email: 'newhire@bonde.ai' } })).toBe(0);

    await ctx.raw
      .post('/auth/invites/accept')
      .send({ token, password: 'Str0ng!Passphrase42' })
      .expect(201);
  });

  it('refuses an unknown token without confirming whether it ever existed', async () => {
    const res = await ctx.raw
      .get('/auth/invites/accept')
      .query({ token: 'not-a-real-token' })
      .expect(200);
    expect(res.body).toMatchObject({ valid: false });
    expect(JSON.stringify(res.body)).not.toContain('not-a-real-token');
  });

  it('revokes a pending invite, which then stops verifying', async () => {
    const created = await ctx.http
      .post('/admin/invites')
      .send({ email: 'newhire@bonde.ai' })
      .expect(201);
    const token = tokenFrom(mail.sent[0]!.html);

    await ctx.http.post(`/admin/invites/${created.body.id}/revoke`).expect(200);

    const peek = await ctx.raw.get('/auth/invites/accept').query({ token }).expect(200);
    expect(peek.body.valid).toBe(false);
    await ctx.raw
      .post('/auth/invites/accept')
      .send({ token, password: 'Str0ng!Passphrase42' })
      .expect(400);
  });

  it('lists invites with a derived status and paginates', async () => {
    await ctx.http.post('/admin/invites').send({ email: 'a@bonde.ai' }).expect(201);
    await ctx.http.post('/admin/invites').send({ email: 'b@bonde.ai' }).expect(201);

    const all = await ctx.http.get('/admin/invites').expect(200);
    expect(all.body).toMatchObject({ total: 2, page: 1, totalPages: 1 });
    expect(all.body.items.every((i: { status: string }) => i.status === 'pending')).toBe(true);

    const filtered = await ctx.http.get('/admin/invites').query({ q: 'a@bonde' }).expect(200);
    expect(filtered.body.total).toBe(1);
  });

  it('409s when the invited address already has an account', async () => {
    const res = await ctx.http.post('/admin/invites').send({ email: SEED_USER_EMAIL }).expect(409);
    expect(res.body.message.join(' ')).toContain('already has an account');
    expect(mail.sent).toHaveLength(0);
  });

  it('replaces a live invite when the same address is invited again', async () => {
    await ctx.http.post('/admin/invites').send({ email: 'a@bonde.ai' }).expect(201);
    const firstToken = tokenFrom(mail.sent[0]!.html);
    await ctx.http.post('/admin/invites').send({ email: 'a@bonde.ai' }).expect(201);
    const secondToken = tokenFrom(mail.sent[1]!.html);

    expect(secondToken).not.toBe(firstToken);
    // The superseded token no longer works.
    await ctx.raw
      .post('/auth/invites/accept')
      .send({ token: firstToken, password: 'Str0ng!Passphrase42' })
      .expect(400);
  });

  it('rejects an invite for a USER (403) and for an unauthenticated caller (401)', async () => {
    ctx.setPrincipal();
    await ctx.http.post('/admin/invites').send({ email: 'a@bonde.ai' }).expect(403);

    await ctx.raw.post('/admin/invites').send({ email: 'a@bonde.ai' }).expect(401);
  });

  it('audits issuance and acceptance', async () => {
    const created = await ctx.http.post('/admin/invites').send({ email: 'a@bonde.ai' }).expect(201);
    const token = tokenFrom(mail.sent[0]!.html);
    await ctx.raw
      .post('/auth/invites/accept')
      .send({ token, password: 'Str0ng!Passphrase42' })
      .expect(201);

    const actions = (
      await ctx.prisma.auditLog.findMany({
        where: { userId: { in: [SEED_USER_ID] } },
        select: { action: true },
      })
    ).map((row) => row.action);
    expect(actions).toContain('admin.invite.create');

    const acceptActions = (
      await ctx.prisma.auditLog.findMany({
        where: { entityId: created.body.id },
        select: { action: true },
      })
    ).map((row) => row.action);
    expect(acceptActions).toContain('auth.invite_accepted');
  });
});
