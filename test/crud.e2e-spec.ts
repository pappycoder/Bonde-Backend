import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootE2EApp,
  SEED_CARD_ID,
  SEED_CHAT_ID,
  SEED_PROVIDER_ID,
  SEED_USER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

describe('Admin CRUD (e2e)', () => {
  let ctx: BootedE2EApp;

  beforeEach(async () => {
    ctx = await bootE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
    ctx.role('ADMIN');
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('blocks non-admin roles with 403', async () => {
    ctx.role('USER');
    const res = await ctx.http.get('/admin/chats').expect(403);
    expect(res.body.statusCode).toBe(403);
  });

  it('POST enforces required fields and returns the created row', async () => {
    const missing = await ctx.http.post('/admin/chats').send({ title: 'No owner' }).expect(400);
    expect(missing.body.message[0]).toMatch(/userId/);

    const created = await ctx.http
      .post('/admin/chats')
      .send({ userId: SEED_USER_ID, title: 'Hello world' })
      .expect(201);
    expect(created.body).toMatchObject({ userId: SEED_USER_ID, title: 'Hello world' });
    expect(created.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects unknown and non-writable fields', async () => {
    const unknown = await ctx.http
      .post('/admin/chats')
      .send({ userId: SEED_USER_ID, nonsense: true })
      .expect(400);
    expect(unknown.body.message[0]).toBe('Unknown field "nonsense"');

    const nonWritable = await ctx.http
      .post('/admin/chats')
      .send({ userId: SEED_USER_ID, id: '99999999-9999-4999-8999-999999999999' })
      .expect(400);
    expect(nonWritable.body.message[0]).toBe('Field "id" is not writable');
  });

  it('lists with pagination and equality filters', async () => {
    await ctx.http.post('/admin/chats').send({ userId: SEED_USER_ID, title: 'Two' }).expect(201);
    await ctx.http.post('/admin/chats').send({ userId: SEED_USER_ID, title: 'Three' }).expect(201);

    const res = await ctx.http
      .get('/admin/chats')
      .query({ page: 1, pageSize: 2, filter: `userId:${SEED_USER_ID}`, orderBy: 'createdAt:asc' })
      .expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    expect(res.body.items.length).toBe(2);
    expect(res.body.items[0]).toHaveProperty('title');
    expect(res.body).toHaveProperty('totalPages');
  });

  it('partial-matches string filters and requires eq for exact', async () => {
    const contains = await ctx.http
      .get('/admin/chats')
      .query({ filter: 'title:oardin' })
      .expect(200);
    expect(contains.body.total).toBeGreaterThanOrEqual(1);

    const exact = await ctx.http
      .get('/admin/chats')
      .query({ filter: 'title:eq:oardin' })
      .expect(200);
    expect(exact.body.total).toBe(0);
  });

  it('rejects filters on hidden fields', async () => {
    const res = await ctx.http
      .get('/admin/card-providers')
      .query({ filter: 'config:1' })
      .expect(400);
    expect(res.body.message[0]).toMatch(/config/);
  });

  it('GET single returns the row, PATCH updates fields, DELETE removes it', async () => {
    const got = await ctx.http.get(`/admin/chats/${SEED_CHAT_ID}`).expect(200);
    expect(got.body).toMatchObject({ id: SEED_CHAT_ID, title: 'Onboarding chat' });

    const patched = await ctx.http
      .patch(`/admin/chats/${SEED_CHAT_ID}`)
      .send({ title: 'Renamed' })
      .expect(200);
    expect(patched.body.title).toBe('Renamed');

    const deleted = await ctx.http.delete(`/admin/chats/${SEED_CHAT_ID}`).expect(200);
    expect(deleted.body).toEqual({ deleted: true, id: SEED_CHAT_ID });

    await ctx.http.get(`/admin/chats/${SEED_CHAT_ID}`).expect(404);
  });

  it('maps unique-violation to 409', async () => {
    const payload = { cardId: SEED_CARD_ID, lockType: 'TIME' };
    await ctx.http.post('/admin/card-locks').send(payload).expect(201);
    const res = await ctx.http.post('/admin/card-locks').send(payload).expect(409);
    expect(res.body.statusCode).toBe(409);
  });

  it('never returns card-provider config (secrets stay server-side)', async () => {
    const created = await ctx.http
      .post('/admin/card-providers')
      .send({ name: 'New Provider', baseUrl: 'https://new.test' })
      .expect(201);
    expect(created.body).not.toHaveProperty('config');

    const list = await ctx.http.get('/admin/card-providers').expect(200);
    const seeded = list.body.items.find((item: { id: string }) => item.id === SEED_PROVIDER_ID);
    expect(seeded).toBeDefined();
    expect(seeded).not.toHaveProperty('config');
  });

  it('rejects writing card-provider config', async () => {
    const res = await ctx.http
      .post('/admin/card-providers')
      .send({ name: 'Hacker', baseUrl: 'https://x.test', config: { key: 'x' } })
      .expect(400);
    expect(res.body.message[0]).toContain('config');
  });

  it('audit-logs are read-only: list works, writes are 405', async () => {
    const list = await ctx.http.get('/admin/audit-logs').expect(200);
    expect(list.body.items).toEqual([]);

    const created = await ctx.http
      .post('/admin/chats')
      .send({ userId: SEED_USER_ID, title: 'Audited' })
      .expect(201);

    const audit = await ctx.http
      .get('/admin/audit-logs')
      .query({ filter: `entityId:${created.body.id}` })
      .expect(200);
    expect(audit.body.items).toHaveLength(1);
    expect(audit.body.items[0]).toMatchObject({
      action: 'admin.crud.create',
      entityType: 'chats',
    });

    const writeCode = await ctx.http
      .patch(`/admin/audit-logs/${created.body.id}`)
      .send({ action: 'tamper' })
      .expect(405);
    expect(writeCode.body.statusCode).toBe(405);

    await ctx.http.delete(`/admin/audit-logs/${created.body.id}`).expect(405);
  });

  it('returns 404 for unknown resources', async () => {
    const res = await ctx.http.post('/admin/does-not-exist').send({}).expect(404);
    expect(res.body.statusCode).toBe(404);
  });

  it('surfaces referential failures as 400', async () => {
    const res = await ctx.http
      .post('/admin/messages')
      .send({ chatId: '99999999-9999-4999-8999-999999999999', role: 'USER', content: 'hi' })
      .expect(400);
    expect(res.body.statusCode).toBe(400);
  });
});
