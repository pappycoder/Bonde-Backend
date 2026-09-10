import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BiometricsService } from './biometrics.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const DEVICE = {
  id: DEVICE_ID,
  userId: USER_ID,
  deviceId: 'device-abc-123',
  deviceName: 'iPhone 15 Pro',
  biometricType: 'FACE',
  publicKey: 'pub-key',
  isActive: true,
  lastUsedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: '7' });
}

function makeService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const biometricDevice = {
    findMany: vi.fn(async () => [DEVICE]),
    count: vi.fn(async () => 1),
    findFirst: vi.fn(async () => DEVICE),
    create: vi.fn(async (args) => ({ ...DEVICE, ...args.data })),
    update: vi.fn(async (args) => ({ ...DEVICE, ...args.data })),
    delete: vi.fn(async () => ({ id: DEVICE_ID })),
    ...overrides.device,
  };
  const prisma = {
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    biometricDevice,
  };
  const service = new BiometricsService(prisma as never);
  return { service, biometricDevice };
}

describe('BiometricsService.list', () => {
  it('returns a paged envelope scoped to the user', async () => {
    const { service, biometricDevice } = makeService();
    await service.list(USER_ID);
    expect(biometricDevice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
  });
});

describe('BiometricsService.get', () => {
  it('404s for a device the user does not own', async () => {
    const { service, biometricDevice } = makeService();
    biometricDevice.findFirst.mockResolvedValue(null);
    await expect(service.get(USER_ID, DEVICE_ID)).rejects.toThrow(NotFoundException);
  });
});

describe('BiometricsService.create', () => {
  it('maps a duplicate deviceId to 409', async () => {
    const { service, biometricDevice } = makeService();
    biometricDevice.create.mockRejectedValue(prismaError('P2002'));
    await expect(
      service.create(USER_ID, {
        deviceId: 'dup',
        deviceName: 'Phone',
        biometricType: 'FACE',
        publicKey: 'pk',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('enrolls a device with a generated id', async () => {
    const { service, biometricDevice } = makeService();
    await service.create(USER_ID, {
      deviceId: 'd1',
      deviceName: 'Phone',
      biometricType: 'FINGERPRINT',
      publicKey: 'pk',
    });
    expect(biometricDevice.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: USER_ID }) }),
    );
  });
});

describe('BiometricsService.remove', () => {
  it('deletes an owned device and reports it', async () => {
    const { service } = makeService();
    await expect(service.remove(USER_ID, DEVICE_ID)).resolves.toEqual({
      deleted: true,
      id: DEVICE_ID,
    });
  });
});
