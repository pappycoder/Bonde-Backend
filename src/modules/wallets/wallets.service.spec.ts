import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WalletsService } from './wallets.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '66666666-6666-4666-8666-666666666666';

const WALLET = {
  id: '77777777-7777-4777-8777-777777777777',
  accountId: ACCOUNT_ID,
  balance: '5000.00',
  currency: 'NGN',
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: '7' });
}

function makeService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const account = {
    findUnique: vi.fn(async () => ({ id: ACCOUNT_ID, userId: USER_ID })),
    ...overrides.account,
  };
  const wallet = {
    findFirst: vi.fn(async () => WALLET),
    create: vi.fn(async (args) => ({ ...WALLET, ...args.data })),
    update: vi.fn(async (args) => ({ ...WALLET, ...args.data })),
    delete: vi.fn(async () => WALLET),
    ...overrides.wallet,
  };
  const prisma = { account, wallet };
  const service = new WalletsService(prisma as never);
  return { service, account, wallet };
}

describe('WalletsService.get', () => {
  it('returns the wallet linked to the current user’s account with 2dp balance', async () => {
    const { service } = makeService();
    await expect(service.get(USER_ID)).resolves.toMatchObject({
      accountId: ACCOUNT_ID,
      balance: '5000.00',
    });
  });

  it('404s when no wallet has been provisioned', async () => {
    const { service, wallet } = makeService();
    wallet.findFirst.mockResolvedValue(null);
    await expect(service.get(USER_ID)).rejects.toThrow(NotFoundException);
  });
});

describe('WalletsService.create', () => {
  it('creates a wallet on the user’s account with defaults', async () => {
    const { service, wallet } = makeService();
    await expect(service.create(USER_ID, {})).resolves.toMatchObject({
      accountId: ACCOUNT_ID,
      balance: '0.00',
      currency: 'NGN',
      isActive: true,
    });
    expect(wallet.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ accountId: ACCOUNT_ID }) }),
    );
  });

  it('404s when the user has no account', async () => {
    const { service, account } = makeService();
    account.findUnique.mockResolvedValue(null);
    await expect(service.create(USER_ID, {})).rejects.toThrow(NotFoundException);
  });

  it('maps a duplicate wallet to 409', async () => {
    const { service, wallet } = makeService();
    wallet.create.mockRejectedValue(prismaError('P2002'));
    await expect(service.create(USER_ID, {})).rejects.toThrow(ConflictException);
  });
});

describe('WalletsService.update', () => {
  it('updates the wallet balance as a 2dp string', async () => {
    const { service } = makeService();
    await expect(
      service.update(USER_ID, { balance: '6000', isActive: false }),
    ).resolves.toMatchObject({
      balance: '6000.00',
      isActive: false,
    });
  });

  it('requeries for ownership before updating', async () => {
    const { service, wallet } = makeService();
    wallet.findFirst.mockResolvedValue(null);
    await expect(service.update(USER_ID, {})).rejects.toThrow(NotFoundException);
  });
});

describe('WalletsService.remove', () => {
  it('deletes the wallet and reports it', async () => {
    const { service, wallet } = makeService();
    await expect(service.remove(USER_ID)).resolves.toEqual({ deleted: true, id: WALLET.id });
    expect(wallet.delete).toHaveBeenCalledWith({ where: { id: WALLET.id } });
  });

  it('rejects deleting a wallet that still has transactions (400)', async () => {
    const { service, wallet } = makeService();
    wallet.delete.mockRejectedValue(prismaError('P2003'));
    await expect(service.remove(USER_ID)).rejects.toThrow(BadRequestException);
  });
});
