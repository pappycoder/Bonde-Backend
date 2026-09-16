import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { VirtualAccountStatus } from '@prisma/client';
import { VirtualAccountsService } from './virtual-accounts.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function makeService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const profile = {
    findUnique: vi.fn(async () => ({
      id: USER_ID,
      fullName: 'Amina Sule',
      email: 'me@bonde.app',
    })),
    ...overrides.profile,
  };
  const virtualAccount = {
    findFirst: vi.fn(async () => null),
    update: vi.fn(async (args) => ({ id: 'va-1', ...args.data })),
    create: vi.fn(async (args) => ({ id: 'va-1', ...args.data })),
    ...overrides.virtualAccount,
  };
  const prisma = { profile, virtualAccount };
  const config = { get: vi.fn(() => ({ vaBankCode: '090567' })) };
  const client = {
    createVirtualAccount: vi.fn(async () => ({
      id: 12345,
      orderRef: 'OR_1',
      accountNumber: '0123456789',
      bankName: 'Wema Bank',
      currency: 'NGN',
      isPermanent: false,
      expiryDate: '2026-10-01T00:00:00.000Z',
      status: 'ACTIVE',
    })),
  };
  const service = new VirtualAccountsService(prisma as never, config as never, client as never);
  return { service, prisma, client, virtualAccount, profile };
}

describe('VirtualAccountsService.getDepositAccount', () => {
  it('reuses an active, unexpired dynamic VA', async () => {
    const { service, virtualAccount, client } = makeService();
    virtualAccount.findFirst.mockResolvedValue({
      id: 'va-1',
      accountNumber: '0123456789',
      bankName: 'Wema Bank',
      accountName: 'AMINA SULE',
      currency: 'NGN',
      isPermanent: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const result = await service.getDepositAccount(USER_ID);

    expect(result).toMatchObject({
      accountNumber: '0123456789',
      bankName: 'Wema Bank',
      currency: 'NGN',
      isPermanent: false,
    });
    expect(client.createVirtualAccount).not.toHaveBeenCalled();
  });

  it('mints a fresh VA when the current one has expired', async () => {
    const { service, virtualAccount, client } = makeService();
    virtualAccount.findFirst.mockResolvedValue({
      id: 'va-1',
      accountNumber: '0123456789',
      bankName: 'Wema Bank',
      currency: 'NGN',
      isPermanent: false,
      expiresAt: new Date(Date.now() - 3600_000),
    });

    const result = await service.getDepositAccount(USER_ID);

    expect(virtualAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: VirtualAccountStatus.EXPIRED } }),
    );
    expect(client.createVirtualAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'me@bonde.app',
        isPermanent: false,
        bankCode: '090567',
        currency: 'NGN',
      }),
    );
    expect(result.accountNumber).toBe('0123456789');
  });

  it('mints a VA when none exists yet and persists it for the user', async () => {
    const { service, virtualAccount, client } = makeService();
    const result = await service.getDepositAccount(USER_ID);

    expect(client.createVirtualAccount).toHaveBeenCalledTimes(1);
    expect(virtualAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER_ID,
          txRef: expect.stringMatching(/^bonde_va_/),
          provider: 'flutterwave',
          currency: 'NGN',
          status: VirtualAccountStatus.ACTIVE,
        }),
      }),
    );
    expect(result.isPermanent).toBe(false);
  });

  it('404s when the profile does not exist', async () => {
    const { service, profile } = makeService();
    profile.findUnique.mockResolvedValue(null);
    await expect(service.getDepositAccount(USER_ID)).rejects.toThrow(NotFoundException);
  });
});
