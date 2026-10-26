import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AccountsService } from './accounts.service.js';
describe('Bank account presentation', () => {
  const setup = (number: string | null) => {
    const prisma = {
      account: {
        findUnique: vi.fn(async (): Promise<unknown> => ({
          id: 'a',
          accountNumber: 'LOCAL_SAMPLE_NUMBER',
        })),
      },
      financeCustomer: { findUnique: vi.fn(async () => ({ bankAccountNumber: number })) },
    };
    return { prisma, service: new AccountsService(prisma as never) };
  };
  it('returns only the verified provider number', async () => {
    expect(await setup('1234567890').service.get('owner')).toMatchObject({
      accountNumber: '1234567890',
    });
  });
  it('never exposes a sample number before banking setup', async () => {
    expect(await setup(null).service.get('owner')).toMatchObject({ accountNumber: '' });
  });
  it('uses the authenticated owner for both reads', async () => {
    const { service, prisma } = setup(null);
    await service.get('owner');
    expect(prisma.account.findUnique).toHaveBeenCalledWith({ where: { userId: 'owner' } });
    expect(prisma.financeCustomer.findUnique).toHaveBeenCalledWith({ where: { userId: 'owner' } });
  });
  it('rejects a missing account', async () => {
    const { service, prisma } = setup(null);
    prisma.account.findUnique.mockResolvedValue(null);
    await expect(service.get('foreign')).rejects.toBeInstanceOf(NotFoundException);
  });
});
