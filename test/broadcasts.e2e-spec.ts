import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootE2EApp, seedBaseFixtures, truncateAll, type BootedE2EApp } from './e2e-app.js';
import { SEED_OTHER_EMAIL, SEED_USER_ID } from './db.js';

/**
 * Broadcasts: an ADMIN fans a message out in-app to every active profile. Runs
 * on its own Redis DB (12, the rate-limit scratch) so counters stay isolated.
 */
process.env.REDIS_URL = 'redis://localhost:6379/12';

const TITLE = 'Scheduled maintenance';

describe('Admin broadcasts (e2e)', () => {
  let ctx: BootedE2EApp;

  beforeAll(async () => {
    ctx = await bootE2EApp();
  });

  /** The second seeded profile's id, by its well-known email. */
  async function otherProfileId(): Promise<string> {
    const profile = await ctx.prisma.profile.findUniqueOrThrow({
      where: { email: SEED_OTHER_EMAIL },
    });
    return profile.id;
  }

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
    ctx.role('ADMIN');
  });

  it('delivers one in-app notification per active profile', async () => {
    const res = await ctx.http
      .post('/admin/broadcasts')
      .send({ title: TITLE, body: 'We will be down for 30 minutes on Sunday.' })
      .expect(201);

    // Only SEED_USER is verified in the fixtures — SEED_OTHER is a
    // half-registered profile and is not an active recipient.
    expect(res.body).toMatchObject({ title: TITLE, status: 'sent', recipientCount: 1 });

    const notifications = await ctx.prisma.notification.findMany({ where: { title: TITLE } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.userId).toBe(SEED_USER_ID);
    for (const notification of notifications) {
      expect(notification).toMatchObject({
        content: 'We will be down for 30 minutes on Sunday.',
        type: 'SYSTEM',
        status: 'UNREAD',
        readAt: null,
      });
      expect((notification.metadata as { source?: string }).source).toBe('admin-broadcast');
    }

    // The recipient sees it in their own feed.
    const feed = await ctx.http.get('/notifications').expect(200);
    expect(feed.body.items.some((item: { title: string }) => item.title === TITLE)).toBe(true);
  });

  it('records the send and audits it', async () => {
    const res = await ctx.http
      .post('/admin/broadcasts')
      .send({ title: TITLE, body: 'We will be down for 30 minutes on Sunday.' })
      .expect(201);

    const record = await ctx.prisma.broadcast.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(record).toMatchObject({ title: TITLE, recipientCount: 1, sentBy: SEED_USER_ID });

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'admin.broadcast.send' },
    });
    expect(audit).toMatchObject({
      entityType: 'broadcast',
      entityId: res.body.id,
      userId: SEED_USER_ID,
    });
    expect(audit.metadata).toMatchObject({ title: TITLE, recipientCount: 1 });
  });

  it('lists sent broadcasts newest first, searchable by title or body', async () => {
    await ctx.http
      .post('/admin/broadcasts')
      .send({ title: 'First notice', body: 'Body one' })
      .expect(201);
    await ctx.http
      .post('/admin/broadcasts')
      .send({ title: 'Second notice', body: 'Body two' })
      .expect(201);

    const all = await ctx.http.get('/admin/broadcasts').expect(200);
    expect(all.body.total).toBe(2);
    expect(all.body.items[0].title).toBe('Second notice');
    expect(all.body.items[0]).toMatchObject({ recipientCount: 1, senderName: 'Amina Sule' });

    const byTitle = await ctx.http.get('/admin/broadcasts').query({ q: 'first' }).expect(200);
    expect(byTitle.body.total).toBe(1);
    const byBody = await ctx.http.get('/admin/broadcasts').query({ q: 'body two' }).expect(200);
    expect(byBody.body.total).toBe(1);
  });

  it('skips profiles that have not finished verification', async () => {
    // A half-registered profile is not an active account.
    await ctx.prisma.profile.create({
      data: {
        id: '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c',
        fullName: 'Pending Signup',
        email: 'pending@bonde.ai',
        emailVerified: false,
      },
    });

    const res = await ctx.http
      .post('/admin/broadcasts')
      .send({ title: TITLE, body: 'We will be down for 30 minutes on Sunday.' })
      .expect(201);

    expect(res.body.recipientCount).toBe(1);
    const recipients = await ctx.prisma.notification.findMany({
      where: { title: TITLE },
      select: { userId: true },
    });
    expect(recipients.map((r) => r.userId)).toEqual([SEED_USER_ID]);
  });

  it('reaches every profile once it is verified', async () => {
    const other = await otherProfileId();
    await ctx.prisma.profile.update({ where: { id: other }, data: { emailVerified: true } });

    const res = await ctx.http
      .post('/admin/broadcasts')
      .send({ title: TITLE, body: 'We will be down for 30 minutes on Sunday.' })
      .expect(201);

    expect(res.body.recipientCount).toBe(2);
    const recipients = await ctx.prisma.notification.findMany({
      where: { title: TITLE },
      select: { userId: true },
      orderBy: { userId: 'asc' },
    });
    expect(recipients.map((r) => r.userId)).toEqual([SEED_USER_ID, other].sort());
  });

  it('400s on an empty audience, writing nothing', async () => {
    await truncateAll(ctx.prisma);

    const res = await ctx.http
      .post('/admin/broadcasts')
      .send({ title: TITLE, body: 'Nobody is listening yet.' })
      .expect(400);
    expect(JSON.stringify(res.body.message)).toContain('No active recipients');
    expect(await ctx.prisma.broadcast.count()).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'admin.broadcast.send' } })).toBe(0);
  });

  it('rejects a blank or oversized broadcast before any write', async () => {
    await ctx.http.post('/admin/broadcasts').send({ title: '  ', body: 'Body' }).expect(400);
    await ctx.http.post('/admin/broadcasts').send({ title: 'Fine', body: 'x' }).expect(400);
    await ctx.http
      .post('/admin/broadcasts')
      .send({ title: 'T'.repeat(141), body: 'Body' })
      .expect(400);
    expect(await ctx.prisma.broadcast.count()).toBe(0);
  });

  it('is ADMIN-only: a USER is 403 and an anonymous caller 401', async () => {
    ctx.setPrincipal();
    await ctx.http
      .post('/admin/broadcasts')
      .send({ title: TITLE, body: 'Should never land.' })
      .expect(403);
    expect(await ctx.prisma.broadcast.count()).toBe(0);

    await ctx.raw
      .post('/admin/broadcasts')
      .send({ title: TITLE, body: 'Should never land.' })
      .expect(401);
    expect(await ctx.prisma.broadcast.count()).toBe(0);
  });

  it('is sendable by a SUPER_ADMIN too', async () => {
    ctx.role('SUPER_ADMIN');
    await ctx.http
      .post('/admin/broadcasts')
      .send({ title: TITLE, body: 'Super admins can speak here.' })
      .expect(201);
    expect(await ctx.prisma.broadcast.count()).toBe(1);
  });

  it('still sends to a single active profile', async () => {
    const res = await ctx.http
      .post('/admin/broadcasts')
      .send({ title: TITLE, body: 'Just you and me.' })
      .expect(201);

    expect(res.body.recipientCount).toBe(1);
    const rows = await ctx.prisma.notification.findMany({
      where: { title: TITLE },
      select: { userId: true },
    });
    expect(rows.map((row) => row.userId)).toEqual([SEED_USER_ID]);
  });
});
