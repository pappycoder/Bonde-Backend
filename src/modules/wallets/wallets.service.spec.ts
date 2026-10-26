import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { WalletsService } from './wallets.service.js';

const setup = (active = true) => {
  const prisma = {
    wallet: {
      findFirst: vi.fn(async (): Promise<unknown> => ({
        id: 'w',
        balance: '999999.00',
        currency: 'NGN',
        isActive: true,
        account: { isActive: active },
      })),
    },
  };
  const finance = {
    wallets: vi.fn(async () => [
      { currency: 'NGN', balance: '123.45', allocated: '20.00', held: '4.00' },
    ]),
  };
  return { prisma, finance, service: new WalletsService(prisma as never, finance as never) };
};
describe('Ledger wallet presentation', () => {
  it('ignores the historical mutable balance and preserves ledger allocation and holds', async () => {
    const { service, prisma, finance } = setup();
    expect(await service.get('owner')).toMatchObject({
      id: 'w',
      balance: '123.45',
      allocated: '20.00',
      held: '4.00',
      live: true,
    });
    expect(prisma.wallet.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { account: { userId: 'owner' } } }),
    );
    expect(finance.wallets).toHaveBeenCalledWith('owner');
  });
  it('shows suspended accounts as inactive', async () => {
    expect(await setup(false).service.get('owner')).toMatchObject({ isActive: false });
  });
  it('rejects unprovisioned or foreign wallets', async () => {
    const { service, prisma, finance } = setup();
    prisma.wallet.findFirst.mockResolvedValue(null);
    await expect(service.get('foreign')).rejects.toBeInstanceOf(NotFoundException);
    expect(finance.wallets).not.toHaveBeenCalled();
  });
});
