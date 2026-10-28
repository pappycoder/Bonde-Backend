import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAIL_SENDER,
  MailSendError,
  type MailMessage,
  type MailSender,
} from '../src/common/mail/mail.types.js';
import { bootE2EApp, seedBaseFixtures, truncateAll, type BootedE2EApp } from './e2e-app.js';
import { SEED_USER_ID } from './db.js';

/**
 * Public marketing surface: the website waitlist + contact form, plus the
 * read-only admin lists built on the generic CRUD registry. Mail is captured
 * in memory — no Resend credentials are exercised.
 *
 * Runs against its own Redis database (db 9) so throttler counters never leak
 * between suites.
 */
process.env.REDIS_URL = 'redis://localhost:6379/9';
// Pin the notification inbox so the assertion cannot drift with a local `.env`.
process.env.CONTACT_INBOX_EMAIL = 'usebonde@gmail.com';
// Many writes in one window: keep the strict counter out of the way so the
// suite tests behaviour, not throttling.
process.env.THROTTLE_STRICT_LIMIT = '1000';
process.env.THROTTLE_STRICT_TTL = '60000';
process.env.THROTTLE_STRICT_BLOCK_DURATION = '60000';

class CaptureMail implements MailSender {
  readonly sent: MailMessage[] = [];
  failNext = false;
  async send(message: MailMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new MailSendError('Simulated delivery failure');
    }
    this.sent.push(message);
  }
}

const signup = {
  email: 'ada@example.com',
  firstName: 'Ada',
  lastName: 'Okafor',
  phone: '08012345678',
};

describe('Marketing (e2e)', () => {
  let ctx: BootedE2EApp;
  const mail = new CaptureMail();

  beforeAll(async () => {
    ctx = await bootE2EApp({ overrides: [{ token: MAIL_SENDER, useValue: mail }] });
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
    mail.sent.length = 0;
    mail.failNext = false;
  });

  it('persists the signup, confirms the visitor and notifies the inbox', async () => {
    const res = await ctx.raw
      .post('/waitlist')
      .send({
        ...signup,
        email: ' Ada@Example.com ',
        firstName: ' Ada ',
        phone: '(080) 1234-5678',
        source: 'hero',
      })
      .expect(201);

    expect(res.body).toMatchObject({
      status: 'joined',
      email: 'ada@example.com',
      alreadyJoined: false,
    });

    const row = await ctx.prisma.waitlistSignup.findUniqueOrThrow({
      where: { email: 'ada@example.com' },
    });
    expect(row).toMatchObject({
      name: 'Ada Okafor',
      firstName: 'Ada',
      lastName: 'Okafor',
      phone: '08012345678',
      source: 'hero',
    });

    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[0]!.to).toBe('ada@example.com');
    expect(mail.sent[0]!.subject).toContain('Welcome to BONDE!');
    expect(mail.sent[0]!.html).toContain('Hello Ada,');
    expect(mail.sent[0]!.html).not.toContain('Hello Ada Okafor,');
    expect(mail.sent[1]!.to).toBe('usebonde@gmail.com');
    expect(mail.sent[1]!.html).toContain('ada@example.com');
    expect(mail.sent[1]!.html).toContain('Okafor');
    expect(mail.sent[1]!.html).toContain('08012345678');
  });

  it('confirms a repeat signup without duplicating rows or notifying the team again', async () => {
    await ctx.raw.post('/waitlist').send(signup).expect(201);
    const again = await ctx.raw
      .post('/waitlist')
      .send({ ...signup, firstName: 'Adanna' })
      .expect(201);

    expect(again.body.alreadyJoined).toBe(true);
    expect(await ctx.prisma.waitlistSignup.count({ where: { email: 'ada@example.com' } })).toBe(1);
    expect(mail.sent).toHaveLength(3);
    expect(mail.sent[2]!.to).toBe('ada@example.com');
    expect(mail.sent[2]!.subject).toContain('already on');
    expect(mail.sent[2]!.html).toContain('Hello Adanna,');
    expect(mail.sent[2]!.html).not.toContain('Hello Ada,');
  });

  it('keeps a place when confirmation fails and retries confirmation on resubmission', async () => {
    mail.failNext = true;
    await ctx.raw.post('/waitlist').send(signup).expect(201);
    expect(await ctx.prisma.waitlistSignup.count({ where: { email: 'ada@example.com' } })).toBe(1);
    const failed = await ctx.prisma.auditLog.findFirst({
      where: { action: 'mail.waitlist_confirmation' },
    });
    expect(failed?.metadata).toMatchObject({ sent: false });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe('usebonde@gmail.com');

    const retry = await ctx.raw.post('/waitlist').send(signup).expect(201);
    expect(retry.body.alreadyJoined).toBe(true);
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[1]!.to).toBe('ada@example.com');
  });

  it('rejects an invalid waitlist email (400)', async () => {
    const res = await ctx.raw
      .post('/waitlist')
      .send({ ...signup, email: 'not-an-email' })
      .expect(400);
    expect(Array.isArray(res.body.message)).toBe(true);
    expect(mail.sent).toHaveLength(0);
  });

  it.each(['email', 'firstName', 'lastName', 'phone'] as const)('requires %s', async (field) => {
    const body: Record<string, unknown> = { ...signup };
    delete body[field];
    await ctx.raw.post('/waitlist').send(body).expect(400);
    expect(await ctx.prisma.waitlistSignup.count()).toBe(0);
    expect(mail.sent).toHaveLength(0);
  });

  it.each([
    { firstName: '   ' },
    { lastName: '   ' },
    { firstName: 'a'.repeat(256) },
    { lastName: 'a'.repeat(256) },
    { firstName: 123 },
    { lastName: ['Ada'] },
    { phone: '123456' },
    { phone: '+1234567890123456' },
    { phone: '080letters123' },
    { phone: '++2348012345678' },
    { phone: 8012345678 },
  ])('rejects invalid contact details: %j', async (invalid) => {
    await ctx.raw
      .post('/waitlist')
      .send({ ...signup, ...invalid })
      .expect(400);
    expect(await ctx.prisma.waitlistSignup.count()).toBe(0);
  });

  it('accepts international formatting and maximum-length names', async () => {
    const names = { firstName: 'A'.repeat(255), lastName: 'B'.repeat(255) };
    await ctx.raw
      .post('/waitlist')
      .send({ ...signup, ...names, phone: '+234 (801) 234-5678' })
      .expect(201);
    const saved = await ctx.prisma.waitlistSignup.findUniqueOrThrow({
      where: { email: signup.email },
    });
    expect(saved).toMatchObject({ ...names, phone: '+2348012345678' });
    expect(saved.name).toHaveLength(511);
  });

  it('fills only missing legacy details and preserves the signup date and name', async () => {
    const { randomUUID } = await import('node:crypto');
    const legacy = await ctx.prisma.waitlistSignup.create({
      data: {
        id: randomUUID(),
        email: signup.email,
        name: 'Original Name',
        firstName: 'Original',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        source: 'legacy',
      },
    });
    const response = await ctx.raw.post('/waitlist').send(signup).expect(201);
    expect(response.body.alreadyJoined).toBe(true);
    expect(
      await ctx.prisma.waitlistSignup.findUniqueOrThrow({ where: { id: legacy.id } }),
    ).toMatchObject({
      firstName: 'Original',
      lastName: signup.lastName,
      phone: signup.phone,
      name: 'Original Name',
      createdAt: legacy.createdAt,
      source: 'legacy',
    });
    await ctx.raw
      .post('/waitlist')
      .send({ ...signup, firstName: 'Replacement', lastName: 'Changed', phone: '+2348011111111' })
      .expect(201);
    expect(
      await ctx.prisma.waitlistSignup.findUniqueOrThrow({ where: { id: legacy.id } }),
    ).toMatchObject({
      firstName: 'Original',
      lastName: signup.lastName,
      phone: signup.phone,
    });
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent.every((message) => message.to === signup.email)).toBe(true);
  });

  it('keeps concurrent submissions idempotent', async () => {
    const responses = await Promise.all([
      ctx.raw.post('/waitlist').send(signup),
      ctx.raw.post('/waitlist').send(signup),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(responses.filter((response) => !response.body.alreadyJoined)).toHaveLength(1);
    expect(await ctx.prisma.waitlistSignup.count()).toBe(1);
    expect(mail.sent.filter((message) => message.to === 'usebonde@gmail.com')).toHaveLength(1);
  });

  it('stores a contact message and notifies the inbox', async () => {
    const res = await ctx.raw
      .post('/contact')
      .send({
        name: 'Chidi',
        email: 'Chidi@Example.com',
        subject: 'Partnership',
        message: 'We would love to work with Bonde.',
      })
      .expect(201);

    expect(res.body).toMatchObject({ status: 'received' });

    const row = await ctx.prisma.contactMessage.findFirstOrThrow({
      where: { email: 'chidi@example.com' },
    });
    expect(row).toMatchObject({
      name: 'Chidi',
      subject: 'Partnership',
      message: 'We would love to work with Bonde.',
    });

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe('usebonde@gmail.com');
    expect(mail.sent[0]!.html).toContain('We would love to work with Bonde.');
  });

  it('rejects a contact message without a body (400)', async () => {
    await ctx.raw.post('/contact').send({ name: 'Chidi', email: 'chidi@example.com' }).expect(400);
    expect(mail.sent).toHaveLength(0);
  });

  it('audits waitlist joins and contact submissions', async () => {
    await ctx.raw.post('/waitlist').send(signup).expect(201);
    await ctx.raw
      .post('/contact')
      .send({ name: 'Chidi', email: 'chidi@example.com', message: 'Hello' })
      .expect(201);

    const actions = (await ctx.prisma.auditLog.findMany({ select: { action: true } })).map(
      (row) => row.action,
    );
    expect(actions).toContain('marketing.waitlist.join');
    expect(actions).toContain('marketing.contact.create');
  });

  it('allows an admin to list marketing records and delete waitlist records', async () => {
    await ctx.raw.post('/waitlist').send(signup).expect(201);
    await ctx.raw
      .post('/contact')
      .send({ name: 'Chidi', email: 'chidi@example.com', message: 'Hello' })
      .expect(201);
    ctx.role('ADMIN');

    const waitlist = await ctx.http.get('/admin/waitlist').expect(200);
    expect(waitlist.body).toMatchObject({ total: 1, page: 1, totalPages: 1 });
    expect(waitlist.body.items[0]).toMatchObject({ ...signup, name: 'Ada Okafor' });

    const contacts = await ctx.http.get('/admin/contacts').expect(200);
    expect(contacts.body).toMatchObject({ total: 1 });
    expect(contacts.body.items[0]).toMatchObject({ email: 'chidi@example.com' });

    // Waitlist entries can be deleted, but cannot be created or edited here.
    await ctx.http.post('/admin/waitlist').send({ email: 'x@example.com' }).expect(405);
    await ctx.http.delete(`/admin/waitlist/${waitlist.body.items[0].id}`).expect(200);
    expect(await ctx.prisma.waitlistSignup.count()).toBe(0);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'admin.crud.delete', entityType: 'waitlist' },
      }),
    ).toBe(1);
  });

  it('denies the admin lists to non-admins (403) and unauthenticated callers (401)', async () => {
    ctx.setPrincipal();
    await ctx.http.get('/admin/waitlist').expect(403);
    await ctx.http.get('/admin/contacts').expect(403);
    await ctx.http.delete(`/admin/waitlist/${randomUUID()}`).expect(403);

    await ctx.raw.get('/admin/waitlist').expect(401);
    await ctx.raw.get('/admin/contacts').expect(401);
    await ctx.raw.delete(`/admin/waitlist/${randomUUID()}`).expect(401);
  });

  it('searches the admin waitlist by email', async () => {
    await ctx.raw.post('/waitlist').send(signup).expect(201);
    await ctx.raw
      .post('/waitlist')
      .send({ ...signup, email: 'bola@example.com' })
      .expect(201);
    ctx.role('ADMIN');

    const res = await ctx.http.get('/admin/waitlist').query({ q: 'bola@' }).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].email).toBe('bola@example.com');
  });

  it.each(['Ada', 'Okafor', '0801234'])('searches new contact fields for %s', async (q) => {
    await ctx.raw.post('/waitlist').send(signup).expect(201);
    ctx.role('ADMIN');
    const response = await ctx.http.get('/admin/waitlist').query({ q }).expect(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items[0]).toMatchObject(signup);
  });

  it('keeps the seeded admin user untouched by public submissions', async () => {
    // Sanity: public writes never create notifications or touch profiles.
    await ctx.raw.post('/waitlist').send(signup).expect(201);
    expect(await ctx.prisma.notification.count({ where: { userId: SEED_USER_ID } })).toBe(1);
  });
});
