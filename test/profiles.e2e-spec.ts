import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootE2EApp,
  SEED_OTHER_ID,
  SEED_OTHER_PHONE,
  SEED_USER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

describe('Profiles self-service (e2e)', () => {
  let ctx: BootedE2EApp;

  beforeEach(async () => {
    ctx = await bootE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('returns the current user’s profile', async () => {
    const res = await ctx.http.get('/profile').expect(200);
    expect(res.body).toMatchObject({ id: SEED_USER_ID, phone: '+2348000000001' });
  });

  it('404s when the profile has not been provisioned', async () => {
    ctx.setPrincipal({ userId: SEED_OTHER_ID });
    await ctx.prisma.profile.delete({ where: { id: SEED_OTHER_ID } });
    const res = await ctx.http.get('/profile').expect(404);
    expect(res.body.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await ctx.raw.get('/profile').expect(401);
    expect(res.body.statusCode).toBe(401);
  });

  it('patches a subset of fields', async () => {
    const res = await ctx.http.patch('/profile').send({ fullName: 'Zainab Ibrahim' }).expect(200);
    expect(res.body.fullName).toBe('Zainab Ibrahim');
  });

  it('rejects taking another user’s phone (409)', async () => {
    const res = await ctx.http.patch('/profile').send({ phone: SEED_OTHER_PHONE }).expect(409);
    expect(res.body.statusCode).toBe(409);
  });

  it('accepts a brand-new phone and resets verification', async () => {
    const res = await ctx.http.patch('/profile').send({ phone: '+2348123456789' }).expect(200);
    expect(res.body).toMatchObject({ phone: '+2348123456789', phoneVerified: false });
  });

  it('stamps onboarding as completed', async () => {
    const res = await ctx.http.patch('/profile').send({ onboardingCompleted: true }).expect(200);
    expect(res.body.onboardingCompletedAt).toBeTruthy();
  });

  it('only allows avatar paths under the user’s own prefix', async () => {
    const foreign = await ctx.http
      .patch('/profile/avatar')
      .send({ path: `u-${'99999999-9999-4999-8999-999999999999'}/avatar.jpeg` })
      .expect(400);
    expect(foreign.body.statusCode).toBe(400);

    const ok = await ctx.http
      .patch('/profile/avatar')
      .send({ path: `u-${SEED_USER_ID}/avatar.jpeg` })
      .expect(200);
    expect(ok.body.avatarUrl).toContain(`u-${SEED_USER_ID}/avatar.jpeg`);
  });
});
