import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ApprovalStatus, Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import { ApprovalsService } from './approvals.service.js';
import { TransactionsService } from './transactions.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WALLET_ID = '77777777-7777-4777-8777-777777777777';
const TX_ID = '66666666-6666-4666-8666-666666666666';
const APPROVAL_ID = '77777777-7777-4777-8777-777777777777';

const TRANSACTION = {
  id: TX_ID,
  userId: USER_ID,
  walletId: WALLET_ID,
  cardId: null,
  chatId: null,
  type: TransactionType.PAYMENT,
  status: TransactionStatus.PENDING,
  approvalStatus: ApprovalStatus.PENDING,
  amount: '2500.00',
  currency: 'NGN',
  description: 'Lunch',
  metadata: {},
  frequency: 'ONE_TIME',
  isRecurring: false,
  recurrenceEndDate: null,
  nextOccurrenceDate: null,
  thresholdWarning: false,
  approvalNotes: null,
  approvedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const APPROVAL = {
  id: APPROVAL_ID,
  transactionId: TX_ID,
  status: ApprovalStatus.PENDING,
  approvedBy: USER_ID,
  notes: null,
  createdAt: new Date(),
};

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: '7' });
}

describe('TransactionsService', () => {
  function makeTransactionsService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
    const transaction = {
      findMany: vi.fn(async () => [TRANSACTION]),
      count: vi.fn(async () => 1),
      findFirst: vi.fn(async () => TRANSACTION),
      create: vi.fn(async (args) => ({ ...TRANSACTION, ...args.data })),
      update: vi.fn(async (args) => ({ ...TRANSACTION, ...args.data })),
      delete: vi.fn(async () => TRANSACTION),
      ...overrides.transaction,
    };
    const wallet = {
      findFirst: vi.fn(async () => ({ id: WALLET_ID })),
      ...overrides.wallet,
    };
    const card = {
      findFirst: vi.fn(async () => ({ id: TX_ID })),
      ...overrides.card,
    };
    const chat = {
      findFirst: vi.fn(async () => ({ id: TX_ID })),
      ...overrides.chat,
    };
    const prisma = {
      $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
      transaction,
      wallet,
      card,
      chat,
    };
    const service = new TransactionsService(prisma as never);
    return { service, transaction, wallet, card, chat };
  }

  it('lists a paged envelope scoped to the user with filters', async () => {
    const { service, transaction } = makeTransactionsService();
    const result = await service.list(USER_ID, {
      status: TransactionStatus.SUCCESS,
      page: 2,
      pageSize: 10,
    });
    expect(result).toMatchObject({ total: 1, page: 2, pageSize: 10 });
    expect(transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID, status: TransactionStatus.SUCCESS },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('returns recent transactions as a bounded plain array', async () => {
    const { service, transaction } = makeTransactionsService();
    await service.recent(USER_ID, 50);
    expect(transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID }, take: 50 }),
    );
  });

  it('404s for a transaction the user does not own', async () => {
    const { service, transaction } = makeTransactionsService();
    transaction.findFirst.mockResolvedValue(null);
    await expect(service.get(USER_ID, TX_ID)).rejects.toThrow(NotFoundException);
  });

  it('normalizes the amount to a 2dp string in reads', async () => {
    const { service } = makeTransactionsService();
    await expect(service.get(USER_ID, TX_ID)).resolves.toMatchObject({ amount: '2500.00' });
  });

  it('creates a transaction against an owned wallet with defaults', async () => {
    const { service, transaction } = makeTransactionsService();
    const result = await service.create(USER_ID, {
      walletId: WALLET_ID,
      type: TransactionType.PAYMENT,
      amount: '2500',
    });
    expect(result).toMatchObject({ amount: '2500.00', status: TransactionStatus.PENDING });
    expect(transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER_ID,
          walletId: WALLET_ID,
          currency: 'NGN',
          isRecurring: false,
        }),
      }),
    );
  });

  it('404s when the wallet is not the user’s', async () => {
    const { service, wallet } = makeTransactionsService();
    wallet.findFirst.mockResolvedValue(null);
    await expect(
      service.create(USER_ID, { walletId: WALLET_ID, type: TransactionType.PAYMENT, amount: '1' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s when the card is not the user’s', async () => {
    const { service, card } = makeTransactionsService();
    card.findFirst.mockResolvedValue(null);
    await expect(
      service.create(USER_ID, {
        walletId: WALLET_ID,
        type: TransactionType.PAYMENT,
        amount: '1',
        cardId: TX_ID,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s when the chat is not the user’s', async () => {
    const { service, chat } = makeTransactionsService();
    chat.findFirst.mockResolvedValue(null);
    await expect(
      service.create(USER_ID, {
        walletId: WALLET_ID,
        type: TransactionType.PAYMENT,
        amount: '1',
        chatId: TX_ID,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('maps a referential integrity error to 400 on create', async () => {
    const { service, transaction } = makeTransactionsService();
    transaction.create.mockRejectedValue(prismaError('P2003'));
    await expect(
      service.create(USER_ID, { walletId: WALLET_ID, type: TransactionType.PAYMENT, amount: '1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('updates an owned transaction and 404s otherwise', async () => {
    const { service, transaction } = makeTransactionsService();
    await expect(
      service.update(USER_ID, TX_ID, { status: TransactionStatus.SUCCESS }),
    ).resolves.toMatchObject({ status: TransactionStatus.SUCCESS });
    transaction.findFirst.mockResolvedValue(null);
    await expect(
      service.update(USER_ID, TX_ID, { status: TransactionStatus.SUCCESS }),
    ).rejects.toThrow(NotFoundException);
  });

  it('deletes an owned transaction and reports it', async () => {
    const { service, transaction } = makeTransactionsService();
    await expect(service.remove(USER_ID, TX_ID)).resolves.toEqual({
      deleted: true,
      id: TX_ID,
    });
    expect(transaction.delete).toHaveBeenCalledWith({ where: { id: TX_ID } });
  });
});

describe('ApprovalsService', () => {
  function makeApprovalsService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
    const transactionApproval = {
      findMany: vi.fn(async () => [APPROVAL]),
      count: vi.fn(async () => 1),
      findFirst: vi.fn(async () => APPROVAL),
      create: vi.fn(async (args) => ({ ...APPROVAL, ...args.data })),
      update: vi.fn(async (args) => ({ ...APPROVAL, ...args.data })),
      delete: vi.fn(async () => APPROVAL),
      ...overrides.approval,
    };
    const transaction = {
      findFirst: vi.fn(async () => TRANSACTION),
      ...overrides.transaction,
    };
    const prisma = {
      $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
      transactionApproval,
      transaction,
    };
    const service = new ApprovalsService(prisma as never);
    return { service, transactionApproval, transaction };
  }

  it('lists approvals resolved through the owning user’s transactions', async () => {
    const { service, transactionApproval } = makeApprovalsService();
    const result = await service.list(USER_ID, { status: ApprovalStatus.PENDING });
    expect(result.total).toBe(1);
    expect(transactionApproval.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { transaction: { userId: USER_ID }, status: ApprovalStatus.PENDING },
      }),
    );
  });

  it('404s when the approval is not on the user’s transaction', async () => {
    const { service, transactionApproval } = makeApprovalsService();
    transactionApproval.findFirst.mockResolvedValue(null);
    await expect(service.get(USER_ID, APPROVAL_ID)).rejects.toThrow(NotFoundException);
  });

  it('creates an approval with the caller as the approver', async () => {
    const { service, transactionApproval } = makeApprovalsService();
    const result = await service.create(USER_ID, { transactionId: TX_ID });
    expect(result).toMatchObject({ approvedBy: USER_ID, status: ApprovalStatus.PENDING });
    expect(transactionApproval.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ transactionId: TX_ID }) }),
    );
  });

  it('404s creating an approval on a foreign transaction', async () => {
    const { service, transaction } = makeApprovalsService();
    transaction.findFirst.mockResolvedValue(null);
    await expect(service.create(USER_ID, { transactionId: TX_ID })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('updates an owned approval', async () => {
    const { service } = makeApprovalsService();
    await expect(
      service.update(USER_ID, APPROVAL_ID, { status: ApprovalStatus.APPROVED, notes: 'ok' }),
    ).resolves.toMatchObject({ status: ApprovalStatus.APPROVED, notes: 'ok' });
  });

  it('deletes an owned approval and reports it', async () => {
    const { service, transactionApproval } = makeApprovalsService();
    await expect(service.remove(USER_ID, APPROVAL_ID)).resolves.toEqual({
      deleted: true,
      id: APPROVAL_ID,
    });
    expect(transactionApproval.delete).toHaveBeenCalledWith({ where: { id: APPROVAL_ID } });
  });
});
