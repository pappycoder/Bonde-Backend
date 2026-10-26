import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { BankAccountsService } from './bank-accounts.service.js';

function setup() {
  const client = {
    banks: vi.fn(async () => [{ name: 'Access Bank', bankCode: '044' }]),
    resolve: vi.fn(async () => ({
      accountNumber: '0690000034',
      accountName: 'Verified Owner',
    })),
  };
  const prisma = {
    withdrawalBankAccount: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async (args) => ({ id: 'saved-id', ...args.create })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  return {
    client,
    prisma,
    service: new BankAccountsService(
      client as never,
      { assertCurrency: vi.fn() } as never,
      prisma as never,
    ),
  };
}
describe('BankAccountsService', () => {
  it('returns supported banks from provider', async () => {
    const { service } = setup();
    expect(await service.list()).toEqual([{ name: 'Access Bank', code: '044' }]);
  });
  it('resolves the selected bank and number through the provider', async () => {
    const { service, client } = setup();
    expect(await service.resolve('044', '0690000034')).toEqual({
      accountNumber: '0690000034',
      accountName: 'Verified Owner',
    });
    expect(client.resolve).toHaveBeenCalledWith('044', '0690000034');
  });
  it('invalid accounts return 400 with actionable copy', async () => {
    const { service, client } = setup();
    client.resolve.mockRejectedValue(new BadRequestException('Invalid'));
    await expect(service.resolve('044', '0690000034')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('provider outages return 502 instead of fabricated account names', async () => {
    const { service, client } = setup();
    client.resolve.mockRejectedValue(new Error('offline'));
    await expect(service.resolve('044', '0690000034')).rejects.toThrow('offline');
  });
  it('bank list outages return 502', async () => {
    const { service, client } = setup();
    client.banks.mockRejectedValue(new Error('offline'));
    await expect(service.list()).rejects.toThrow('offline');
  });
});

describe('Saved withdrawal bank account ownership', () => {
  it('lists only the authenticated user accounts', async () => {
    const { service, prisma } = setup();
    await service.saved('user-a');
    expect(prisma.withdrawalBankAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-a' } }),
    );
  });
  it('verifies bank/name and upserts by owner, bank and account', async () => {
    const { service, prisma, client } = setup();
    const saved = await service.save('user-a', '044', '0690000034');
    expect(saved.accountName).toBe('Verified Owner');
    expect(client.resolve).toHaveBeenCalledWith('044', '0690000034');
    expect(prisma.withdrawalBankAccount.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_bankCode_accountNumber: {
            userId: 'user-a',
            bankCode: '044',
            accountNumber: '0690000034',
          },
        },
        create: expect.objectContaining({
          userId: 'user-a',
          bankName: 'Access Bank',
          accountName: 'Verified Owner',
        }),
      }),
    );
  });
  it('never saves an account the provider cannot verify', async () => {
    const { service, prisma, client } = setup();
    client.resolve.mockRejectedValue(new BadRequestException('Invalid'));
    await expect(service.save('user-a', '044', '0690000034')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.withdrawalBankAccount.upsert).not.toHaveBeenCalled();
  });
  it('unknown banks are not saved', async () => {
    const { service, prisma } = setup();
    await expect(service.save('user-a', '999', '0690000034')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.withdrawalBankAccount.upsert).not.toHaveBeenCalled();
  });
  it('deletion is guarded by both ID and authenticated owner', async () => {
    const { service, prisma } = setup();
    prisma.withdrawalBankAccount.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.remove('user-b', 'other-user-account')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.withdrawalBankAccount.deleteMany).toHaveBeenCalledWith({
      where: { id: 'other-user-account', userId: 'user-b' },
    });
  });
});
