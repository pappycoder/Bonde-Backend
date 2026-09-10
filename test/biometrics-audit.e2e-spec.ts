import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootE2EApp,
  SEED_OTHER_ID,
  SEED_USER_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';

describe('Biometric devices + audit log (self-service e2e)', () => {
  let ctx: BootedE2EApp;

  beforeEach(async () => {
    ctx = await bootE2EApp();
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('lists the current user’s enrolled devices', async () => {
    const res = await ctx.http.get('/biometric-devices').expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      deviceId: 'device-abc-123',
      biometricType: 'FACE',
    });
  });

  it('enrolls a device and rejects a duplicate deviceId (409)', async () => {
    const created = await ctx.http
      .post('/biometric-devices')
      .send({
        deviceId: 'device-xyz',
        deviceName: 'Samsung S25',
        biometricType: 'FINGERPRINT',
        publicKey: 'pub-key-2',
      })
      .expect(201);
    expect(created.body).toMatchObject({ biometricType: 'FINGERPRINT', isActive: true });

    await ctx.http
      .post('/biometric-devices')
      .send({
        deviceId: 'device-xyz',
        deviceName: 'Samsung S25',
        biometricType: 'FACE',
        publicKey: 'pub-key-3',
      })
      .expect(409);
  });

  it('updates and deletes an owned device', async () => {
    const list = await ctx.http.get('/biometric-devices').expect(200);
    const id = list.body.items[0].id as string;

    const updated = await ctx.http
      .patch(`/biometric-devices/${id}`)
      .send({ deviceName: 'Work phone', isActive: false })
      .expect(200);
    expect(updated.body).toMatchObject({ deviceName: 'Work phone', isActive: false });

    await ctx.http.delete(`/biometric-devices/${id}`).expect(200);
    await ctx.http.get(`/biometric-devices/${id}`).expect(404);
  });

  it('404s devices the user does not own', async () => {
    const foreign = await ctx.prisma.biometricDevice.create({
      data: {
        id: randomUUID(),
        userId: SEED_OTHER_ID,
        deviceId: 'device-other',
        deviceName: 'Other phone',
        biometricType: 'FACE',
        publicKey: 'pk-other',
      },
    });
    await ctx.http.get(`/biometric-devices/${foreign.id}`).expect(404);
  });

  it('lists and gets the current user’s audit trail only', async () => {
    await ctx.prisma.auditLog.create({
      data: {
        id: randomUUID(),
        userId: SEED_USER_ID,
        action: 'card.pause',
        entityType: 'card',
        entityId: randomUUID(),
      },
    });
    await ctx.prisma.auditLog.create({
      data: {
        id: randomUUID(),
        userId: SEED_OTHER_ID,
        action: 'profile.update',
        entityType: 'profile',
        entityId: randomUUID(),
      },
    });

    const list = await ctx.http.get('/audit-logs').expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].action).toBe('card.pause');

    const got = await ctx.http.get(`/audit-logs/${list.body.items[0].id}`).expect(200);
    expect(got.body.action).toBe('card.pause');

    const other = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'profile.update' },
    });
    await ctx.http.get(`/audit-logs/${other.id}`).expect(404);
  });
});
