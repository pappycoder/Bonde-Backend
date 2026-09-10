import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ThresholdsService } from './thresholds.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const THRESHOLD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const THRESHOLD = {
  id: THRESHOLD_ID,
  userId: USER_ID,
  thresholdType: 'LARGE_AMOUNT',
  thresholdValue: '5000.00',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: '7' });
}

function makeService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const transactionThreshold = {
    findMany: vi.fn(async () => [THRESHOLD]),
    count: vi.fn(async () => 1),
    findFirst: vi.fn(async () => THRESHOLD),
    create: vi.fn(async (args) => ({ ...THRESHOLD, ...args.data })),
    update: vi.fn(async (args) => ({ ...THRESHOLD, ...args.data })),
    delete: vi.fn(async () => ({ id: THRESHOLD_ID })),
    ...overrides.threshold,
  };
  const prisma = {
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    transactionThreshold,
  };
  const service = new ThresholdsService(prisma as never);
  return { service, transactionThreshold };
}

describe('ThresholdsService.list', () => {
  it('returns a paged envelope scoped to the user', async () => {
    const { service, transactionThreshold } = makeService();
    await service.list(USER_ID);
    expect(transactionThreshold.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
  });
});

describe('ThresholdsService.get', () => {
  it('404s for a threshold the user does not own', async () => {
    const { service, transactionThreshold } = makeService();
    transactionThreshold.findFirst.mockResolvedValue(null);
    await expect(service.get(USER_ID, THRESHOLD_ID)).rejects.toThrow(NotFoundException);
  });
});

describe('ThresholdsService.create', () => {
  it('maps a duplicate type to 409', async () => {
    const { service, transactionThreshold } = makeService();
    transactionThreshold.create.mockRejectedValue(prismaError('P2002'));
    await expect(
      service.create(USER_ID, { thresholdType: 'LARGE_AMOUNT', thresholdValue: '5000.00' }),
    ).rejects.toThrow(ConflictException);
  });

  it('creates a threshold and defaults isActive to true', async () => {
    const { service, transactionThreshold } = makeService();
    await service.create(USER_ID, { thresholdType: 'FIRST_TIME', thresholdValue: '1000.00' });
    expect(transactionThreshold.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: USER_ID, isActive: true }),
      }),
    );
  });

  it('normalizes the value to a 2dp string in the response', async () => {
    const { service } = makeService();
    await expect(
      service.create(USER_ID, { thresholdType: 'FIRST_TIME', thresholdValue: '1000' }),
    ).resolves.toMatchObject({ thresholdValue: '1000.00' });
  });
});

describe('ThresholdsService.update', () => {
  it('updates an owned threshold and 404s otherwise', async () => {
    const { service, transactionThreshold } = makeService();
    transactionThreshold.findFirst.mockResolvedValue(null);
    await expect(service.update(USER_ID, THRESHOLD_ID, { isActive: false })).rejects.toThrow(
      NotFoundException,
    );
    transactionThreshold.findFirst.mockResolvedValue(THRESHOLD);
    await expect(service.update(USER_ID, THRESHOLD_ID, { isActive: false })).resolves.toMatchObject(
      {
        isActive: false,
      },
    );
  });
});

describe('ThresholdsService.remove', () => {
  it('deletes an owned threshold and reports it', async () => {
    const { service } = makeService();
    await expect(service.remove(USER_ID, THRESHOLD_ID)).resolves.toEqual({
      deleted: true,
      id: THRESHOLD_ID,
    });
  });
});
