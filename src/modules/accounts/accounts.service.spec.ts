import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AccountType, Prisma } from '@prisma/client';
import { AccountsService } from './accounts.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

const ACCOUNT = {
  id: '66666666-6666-4666-8666-666666666666',
  userId: USER_ID,
  accountNumber: '0123456789',
  accountType: AccountType.CHECKING as AccountType,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: '7' });
}

function makeService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const account = {
    findUnique: vi.fn(async () => ACCOUNT),
    create: vi.fn(async (args) => ({ ...ACCOUNT, ...args.data })),
    update: vi.fn(async (args) => ({ ...ACCOUNT, ...args.data })),
    delete: vi.fn(async () => ACCOUNT),
    ...overrides.account,
  };
  const prisma = { account };
  const service = new AccountsService(prisma as never);
  return { service, account };
}

describe('AccountsService.get', () => {
  it('returns the user’s single account', async () => {
    const { service, account } = makeService();
    await expect(service.get(USER_ID)).resolves.toMatchObject({ id: ACCOUNT.id });
    expect(account.findUnique).toHaveBeenCalledWith({ where: { userId: USER_ID } });
  });

  it('404s until an account has been provisioned', async () => {
    const { service, account } = makeService();
    account.findUnique.mockResolvedValue(null);
    await expect(service.get(USER_ID)).rejects.toThrow(NotFoundException);
  });
});

describe('AccountsService.create', () => {
  it('creates an account with the supplied account number', async () => {
    const { service, account } = makeService();
    await service.create(USER_ID, { accountNumber: '9876543210' });
    expect(account.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER_ID,
          accountNumber: '9876543210',
          accountType: AccountType.CHECKING,
          isActive: true,
        }),
      }),
    );
  });

  it('generates a Luhn account number when omitted', async () => {
    const { service, account } = makeService();
    await service.create(USER_ID, {});
    const data = account.create.mock.calls[0][0].data as { accountNumber: string };
    expect(data.accountNumber).toMatch(/^\d{10}$/);
  });

  it('maps a duplicate userId/accountNumber to 409', async () => {
    const { service, account } = makeService();
    account.create.mockRejectedValue(prismaError('P2002'));
    await expect(service.create(USER_ID, {})).rejects.toThrow(ConflictException);
  });
});

describe('AccountsService.update', () => {
  it('updates an owned account and 404s otherwise', async () => {
    const { service, account } = makeService();
    account.findUnique.mockResolvedValue(null);
    await expect(service.update(USER_ID, { isActive: false })).rejects.toThrow(NotFoundException);
    account.findUnique.mockResolvedValue(ACCOUNT);
    await expect(
      service.update(USER_ID, { accountType: AccountType.SAVINGS }),
    ).resolves.toMatchObject({
      accountType: AccountType.SAVINGS,
    });
  });
});

describe('AccountsService.remove', () => {
  it('deletes the user’s account and reports it', async () => {
    const { service, account } = makeService();
    await expect(service.remove(USER_ID)).resolves.toEqual({ deleted: true, id: ACCOUNT.id });
    expect(account.delete).toHaveBeenCalledWith({ where: { userId: USER_ID } });
  });

  it('404s when there is no account to delete', async () => {
    const { service, account } = makeService();
    account.findUnique.mockResolvedValue(null);
    await expect(service.remove(USER_ID)).rejects.toThrow(NotFoundException);
  });
});
