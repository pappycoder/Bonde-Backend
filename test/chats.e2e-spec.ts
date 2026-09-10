import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootE2EApp,
  SEED_CHAT_ID,
  SEED_OTHER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

describe('Chats self-service (e2e)', () => {
  let ctx: BootedE2EApp;

  beforeEach(async () => {
    ctx = await bootE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
  });

  afterEach(async () => {
    await ctx.close();
  });

  async function seedChatFor(userId: string) {
    return ctx.prisma.chat.create({
      data: { id: randomUUID(), userId, title: 'Other chat' },
    });
  }

  it('lists the current user’s chat history', async () => {
    await seedChatFor(SEED_OTHER_ID);
    const res = await ctx.http.get('/chats').expect(200);
    expect(res.body).toMatchObject({ total: 1 });
    expect(res.body.items[0]).toMatchObject({ id: SEED_CHAT_ID, title: 'Onboarding chat' });
  });

  it('creates a chat with and without a title', async () => {
    const named = await ctx.http.post('/chats').send({ title: 'Travel' }).expect(201);
    expect(named.body).toMatchObject({ title: 'Travel' });

    const unnamed = await ctx.http.post('/chats').send({}).expect(201);
    expect(unnamed.body.title).toBeNull();
  });

  it('gets, renames and deletes one of the current user’s chats', async () => {
    const got = await ctx.http.get(`/chats/${SEED_CHAT_ID}`).expect(200);
    expect(got.body.id).toBe(SEED_CHAT_ID);

    const updated = await ctx.http
      .patch(`/chats/${SEED_CHAT_ID}`)
      .send({ title: 'Renamed' })
      .expect(200);
    expect(updated.body.title).toBe('Renamed');

    await ctx.http.delete(`/chats/${SEED_CHAT_ID}`).expect(200);
    await ctx.http.get(`/chats/${SEED_CHAT_ID}`).expect(404);
  });

  it('lists messages chronologically and lets the user append USER messages', async () => {
    const list = await ctx.http.get(`/chats/${SEED_CHAT_ID}/messages`).expect(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items.map((m: { role: string }) => m.role)).toEqual(['USER', 'ASSISTANT']);

    const created = await ctx.http
      .post(`/chats/${SEED_CHAT_ID}/messages`)
      .send({ content: 'Transfer 2000 to savings' })
      .expect(201);
    expect(created.body).toMatchObject({ role: 'USER' });

    const after = await ctx.http.get(`/chats/${SEED_CHAT_ID}/messages`).expect(200);
    expect(after.body.total).toBe(3);
    expect(after.body.items[2].content).toBe('Transfer 2000 to savings');
  });

  it('404s chats and messages when not owned', async () => {
    const foreign = await seedChatFor(SEED_OTHER_ID);
    await ctx.http.get(`/chats/${foreign.id}`).expect(404);
    await ctx.http.patch(`/chats/${foreign.id}`).send({ title: 'hack' }).expect(404);
    await ctx.http.get(`/chats/${foreign.id}/messages`).expect(404);
    await ctx.http.post(`/chats/${foreign.id}/messages`).send({ content: 'hi' }).expect(404);
  });
});
