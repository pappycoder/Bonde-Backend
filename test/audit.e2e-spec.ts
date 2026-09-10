import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootE2EApp,
  SEED_USER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

describe('Audit trail (e2e)', () => {
  let ctx: BootedE2EApp;

  beforeEach(async () => {
    ctx = await bootE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('records profile changes with the acting user', async () => {
    await ctx.http.patch('/profile').send({ fullName: 'Updated Name' }).expect(200);

    const entry = await ctx.prisma.auditLog.findFirst({
      where: { action: 'profile.update', entityType: 'profile' },
    });
    expect(entry).toMatchObject({
      userId: SEED_USER_ID,
      entityId: SEED_USER_ID,
      entityType: 'profile',
      action: 'profile.update',
    });
  });

  it('records avatar changes', async () => {
    await ctx.http
      .patch('/profile/avatar')
      .send({ path: `u-${SEED_USER_ID}/new.jpeg` })
      .expect(200);

    const entry = await ctx.prisma.auditLog.findFirst({
      where: { action: 'profile.avatar', entityType: 'profile' },
    });
    expect(entry?.entityId).toBe(SEED_USER_ID);
  });

  it('admin actions are visible through the read-only audit-logs endpoint', async () => {
    ctx.role('ADMIN');
    const created = await ctx.http
      .post('/admin/chats')
      .send({ userId: SEED_USER_ID, title: 'Track me' })
      .expect(201);

    const list = await ctx.http
      .get('/admin/audit-logs')
      .query({ filter: `entityId:${created.body.id}` })
      .expect(200);
    const entry = list.body.items[0];
    expect(entry).toMatchObject({
      action: 'admin.crud.create',
      entityType: 'chats',
      userId: SEED_USER_ID,
      entityId: created.body.id,
    });
  });
});
