import { describe, expect, it, vi } from 'vitest';
import { Prisma, ProviderEventStatus, TransactionStatus, TransactionType } from '@prisma/client';
import { DepositsService } from './deposits.service.js';
import type { ChargeCompletedData } from '../flutterwave/flutterwave.types.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WALLET_ID = '77777777-7777-4777-8777-777777777777';

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: '7' });
}

function makeService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const providerEvent = {
    create: vi.fn(async () => ({ id: 'event-1' })),
    update: vi.fn(async () => ({})),
    ...overrides.providerEvent,
  };
  const virtualAccount = {
    findUnique: vi.fn(async () => ({
      id: 'va-1',
      userId: USER_ID,
      txRef: 'bonde_va_1',
      accountNumber: '0123456789',
      bankName: 'Wema Bank',
      currency: 'NGN',
      status: 'ACTIVE',
    })),
    ...overrides.virtualAccount,
  };
  const wallet = {
    findFirst: vi.fn(async () => ({ id: WALLET_ID, balance: '5000.00' })),
    update: vi.fn(async (args) => ({ id: WALLET_ID, ...args.data })),
    ...overrides.wallet,
  };
  const transaction = {
    create: vi.fn(async (args) => ({ id: 'tx-1', ...args.data })),
    ...overrides.transaction,
  };
  const prisma = {
    providerEvent,
    virtualAccount,
    wallet,
    transaction,
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  };
  const activity = { record: vi.fn(async () => undefined) };
  const service = new DepositsService(prisma as never, activity as never);
  return { service, prisma, activity, virtualAccount, wallet, transaction, providerEvent };
}

const CHARGE: ChargeCompletedData = {
  id: 9001,
  txRef: 'bonde_va_1',
  flwRef: 'flw_9001',
  amount: 5000,
  currency: 'NGN',
  status: 'successful',
};

describe('DepositsService.handleChargeCompleted', () => {
  it('credits the wallet and marks the event processed', async () => {
    const { service, wallet, transaction, providerEvent, activity } = makeService();
    const result = await service.handleChargeCompleted(CHARGE);

    expect(result).toEqual({ status: 'processed', reference: 'flutterwave:charge.completed:9001' });
    expect(wallet.update).toHaveBeenCalledWith({
      where: { id: WALLET_ID },
      data: { balance: { increment: expect.any(Prisma.Decimal) } },
    });
    expect(transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER_ID,
          walletId: WALLET_ID,
          type: TransactionType.DEPOSIT,
          status: TransactionStatus.SUCCESS,
          amount: '5000.00',
          currency: 'NGN',
        }),
      }),
    );
    expect(providerEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ProviderEventStatus.PROCESSED }),
      }),
    );
    expect(activity.record).toHaveBeenCalled();
  });

  it('acks replays as duplicates without double-crediting', async () => {
    const { service, prisma, wallet, transaction } = makeService();
    wallet.update.mockClear();
    transaction.create.mockClear();
    (prisma.providerEvent.create as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      prismaError('P2002'),
    );

    const result = await service.handleChargeCompleted(CHARGE);

    expect(result).toEqual({
      status: 'duplicate',
      reference: 'flutterwave:charge.completed:9001',
    });
    expect(wallet.update).not.toHaveBeenCalled();
    expect(transaction.create).not.toHaveBeenCalled();
  });

  it('ignores events that reference an unknown or expired VA', async () => {
    const { service, virtualAccount, prisma } = makeService();
    virtualAccount.findUnique.mockResolvedValue(null);

    const result = await service.handleChargeCompleted(CHARGE);
    expect(result.status).toBe('ignored');
    expect(prisma.providerEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ProviderEventStatus.FAILED }),
      }),
    );
  });

  it('ignores events whose amount is missing or non-positive', async () => {
    const { service } = makeService();
    const result = await service.handleChargeCompleted({ ...CHARGE, amount: 0 });
    expect(result.status).toBe('ignored');
  });

  it('ignores events whose currency does not match the VA', async () => {
    const { service } = makeService();
    const result = await service.handleChargeCompleted({ ...CHARGE, currency: 'USD' });
    expect(result.status).toBe('ignored');
  });

  it('ignores events when the user has no wallet', async () => {
    const { service, wallet } = makeService();
    wallet.findFirst.mockResolvedValue(null);
    const result = await service.handleChargeCompleted(CHARGE);
    expect(result.status).toBe('ignored');
  });
});
