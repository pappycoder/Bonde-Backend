import { describe, expect, it, vi } from 'vitest';
import { BadGatewayException, BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, ProviderEventStatus, TransactionStatus } from '@prisma/client';
import { WithdrawalsService } from './withdrawals.service.js';
import type { TransferDisburseData } from '../flutterwave/flutterwave.types.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WALLET_ID = '77777777-7777-4777-8777-777777777777';
const TX_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: '7' });
}

function makeService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const providerEvent = {
    create: vi.fn(async () => ({ id: 'outcome-event' })),
    update: vi.fn(async () => ({})),
    findFirst: vi.fn(async () => ({
      id: 'reserve-event',
      transactionId: TX_ID,
      provider: 'flutterwave',
    })),
    ...overrides.providerEvent,
  };
  const transaction = {
    create: vi.fn(async (args) => ({ id: TX_ID, ...args.data })),
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => ({
      id: TX_ID,
      userId: USER_ID,
      walletId: WALLET_ID,
      amount: '2000.00',
      currency: 'NGN',
      status: TransactionStatus.PENDING,
    })),
    count: vi.fn(async () => 0),
    update: vi.fn(async (args) => ({ id: TX_ID, ...args.data })),
    ...overrides.transaction,
  };
  const transactionThreshold = {
    findMany: vi.fn(async () => []),
    ...overrides.transactionThreshold,
  };
  const wallet = {
    findFirst: vi.fn(async () => ({ id: WALLET_ID, balance: '5000.00', currency: 'NGN' })),
    updateMany: vi.fn(async () => ({ count: 1 })),
    update: vi.fn(async (args) => ({ id: WALLET_ID, ...args.data })),
    ...overrides.wallet,
  };
  const delegates = { providerEvent, transaction, transactionThreshold, wallet };
  const prisma = {
    ...delegates,
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(delegates);
      return Promise.all(arg as Array<Promise<unknown>>);
    }),
  };
  const client = { initiateTransfer: vi.fn(async () => ({ status: 'NEW' })) };
  const activity = { record: vi.fn(async () => undefined) };
  const service = new WithdrawalsService(prisma as never, activity as never, client as never);
  return { service, prisma, client, activity, transaction, wallet, providerEvent };
}

const DTO = {
  amount: '2000.00',
  accountNumber: '0123456789',
  bankCode: '035',
  narration: 'Test payout',
};

const DISBURSE: TransferDisburseData = {
  id: 7001,
  reference: 'bonde_wd_123',
  status: 'SUCCESSFUL',
  amount: 2000,
  currency: 'NGN',
};

describe('WithdrawalsService.request', () => {
  it('reserves the wallet balance and initiates the transfer', async () => {
    const { service, client, wallet } = makeService();
    const result = await service.request(USER_ID, DTO);

    expect(result).toEqual(
      expect.objectContaining({
        amount: '2000.00',
        currency: 'NGN',
        status: TransactionStatus.PENDING,
      }),
    );
    expect(wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: WALLET_ID, balance: { gte: expect.any(Prisma.Decimal) } },
      }),
    );
    expect(client.initiateTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        accountBank: '035',
        accountNumber: '0123456789',
        reference: expect.stringMatching(/^bonde_wd_/),
      }),
    );
  });

  it('rejects a non-positive amount', async () => {
    const { service, client } = makeService();
    await expect(service.request(USER_ID, { ...DTO, amount: '0.00' })).rejects.toThrow(
      BadRequestException,
    );
    expect(client.initiateTransfer).not.toHaveBeenCalled();
  });

  it('rejects a currency mismatch with the wallet', async () => {
    const { service, client } = makeService();
    await expect(service.request(USER_ID, { ...DTO, currency: 'USD' })).rejects.toThrow(
      BadRequestException,
    );
    expect(client.initiateTransfer).not.toHaveBeenCalled();
  });

  it('409s when a withdrawal is already in flight', async () => {
    const { service, transaction, client } = makeService();
    transaction.findFirst.mockResolvedValue({ id: TX_ID, status: TransactionStatus.PENDING });
    await expect(service.request(USER_ID, DTO)).rejects.toThrow(ConflictException);
    expect(client.initiateTransfer).not.toHaveBeenCalled();
  });

  it('rolls back fully and does not initiate when the balance is insufficient', async () => {
    const { service, client, wallet } = makeService();
    wallet.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.request(USER_ID, DTO)).rejects.toThrow(BadRequestException);
    expect(client.initiateTransfer).not.toHaveBeenCalled();
  });

  it('refunds the reservation and 502s when the provider call fails synchronously', async () => {
    const { service, client, transaction, prisma, providerEvent } = makeService();
    client.initiateTransfer.mockRejectedValue(new Error('provider down'));

    await expect(service.request(USER_ID, DTO)).rejects.toThrow(BadGatewayException);
    expect(transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: TransactionStatus.FAIL } }),
    );
    expect(providerEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ProviderEventStatus.FAILED }),
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

describe('WithdrawalsService.handleTransferDisburse', () => {
  it('marks the reserved withdrawal SUCCESS on a SUCCESSFUL payout', async () => {
    const { service, transaction, providerEvent, activity } = makeService();
    const result = await service.handleTransferDisburse(DISBURSE);

    expect(result.status).toBe('processed');
    expect(transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TX_ID },
        data: { status: TransactionStatus.SUCCESS },
      }),
    );
    expect(providerEvent.update).toHaveBeenCalledTimes(1); // the outcome event
    expect(activity.record).toHaveBeenCalled();
  });

  it('refunds the wallet and marks the transaction FAIL on a failed payout', async () => {
    const { service, transaction, wallet } = makeService();
    await service.handleTransferDisburse({ ...DISBURSE, status: 'FAILED' });

    expect(transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: TransactionStatus.FAIL } }),
    );
    expect(wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { balance: { increment: '2000.00' } },
      }),
    );
  });

  it('acks replays as duplicates without double-processing', async () => {
    const { service, prisma, wallet } = makeService();
    (prisma.providerEvent.create as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      prismaError('P2002'),
    );
    const result = await service.handleTransferDisburse(DISBURSE);
    expect(result.status).toBe('duplicate');
    expect(wallet.update).not.toHaveBeenCalled();
  });

  it('ignores outcomes whose reserve reference cannot be resolved', async () => {
    const { service, providerEvent, transaction } = makeService();
    providerEvent.findFirst.mockResolvedValue(null);
    const result = await service.handleTransferDisburse({ ...DISBURSE, reference: 'unknown' });
    expect(result.status).toBe('ignored');
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it('ignores outcomes for transactions that are no longer PENDING', async () => {
    const { service, transaction } = makeService();
    transaction.findUnique.mockResolvedValue({
      id: TX_ID,
      userId: USER_ID,
      walletId: WALLET_ID,
      amount: '2000.00',
      currency: 'NGN',
      status: TransactionStatus.SUCCESS,
    });
    const result = await service.handleTransferDisburse(DISBURSE);
    expect(result.status).toBe('ignored');
  });
});

describe('WithdrawalsService.handleTransferReversal', () => {
  it('refunds the reservation like a FAILED payout', async () => {
    const { service, transaction, wallet } = makeService();
    const result = await service.handleTransferReversal(DISBURSE);

    expect(result.status).toBe('processed');
    expect(transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: TransactionStatus.FAIL } }),
    );
    expect(wallet.update).toHaveBeenCalled();
  });
});
