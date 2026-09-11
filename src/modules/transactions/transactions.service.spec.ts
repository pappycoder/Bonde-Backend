import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ApprovalStatus, Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import { ApprovalsService } from './approvals.service.js';
import { TransactionsService } from './transactions.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WALLET_ID = '77777777-7777-4777-8777-777777777777';
const TX_ID = '66666666-6666-4666-8666-666666666666';
const APPROVAL_ID = '77777777-7777-4777-8777-777777777777';
const CARD_ID = '22222222-2222-4222-8222-222222222222';

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
const CARD_ROW = {
  id: CARD_ID,
  cardNumberLast4: '4242',
  cardType: 'virtual',
  createdAt: new Date('2030-01-01T00:00:00.000Z'),
  totalSpent: '0',
};
/** Approval rows fetched via the service always embed transaction + card. */
const APPROVAL_ROW = { ...APPROVAL, transaction: { ...TRANSACTION, card: null } };
const SUCCESS_TX_ON_CARD = {
  ...TRANSACTION,
  cardId: CARD_ID,
  status: TransactionStatus.SUCCESS,
  amount: new Prisma.Decimal('2500.00'),
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
      update: vi.fn(async () => ({})),
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

  it('increments card.totalSpent for a successful PAYMENT on that card', async () => {
    const { service, card } = makeTransactionsService();
    await service.create(USER_ID, {
      walletId: WALLET_ID,
      type: TransactionType.PAYMENT,
      amount: '2500',
      status: TransactionStatus.SUCCESS,
      cardId: CARD_ID,
    });
    expect(card.update).toHaveBeenCalledWith({
      where: { id: CARD_ID },
      data: { totalSpent: { increment: '2500' } },
    });
  });

  it('does not tick totalSpent for pending or non-PAYMENT transactions', async () => {
    const { service, card } = makeTransactionsService();
    await service.create(USER_ID, {
      walletId: WALLET_ID,
      type: TransactionType.PAYMENT,
      amount: '2500',
      cardId: CARD_ID,
    });
    await service.create(USER_ID, {
      walletId: WALLET_ID,
      type: TransactionType.WITHDRAWAL,
      amount: '100',
      status: TransactionStatus.SUCCESS,
      cardId: CARD_ID,
    });
    await service.create(USER_ID, {
      walletId: WALLET_ID,
      type: TransactionType.PAYMENT,
      amount: '100',
      status: TransactionStatus.SUCCESS,
    });
    expect(card.update).not.toHaveBeenCalled();
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

  it('increments totalSpent when a card payment becomes SUCCESS', async () => {
    const { service, transaction, card } = makeTransactionsService();
    transaction.findFirst.mockResolvedValue({ ...TRANSACTION, cardId: CARD_ID });
    await service.update(USER_ID, TX_ID, { status: TransactionStatus.SUCCESS });
    const increment = card.update.mock.calls[0][0].data.totalSpent.increment as Prisma.Decimal;
    expect(increment.toFixed(2)).toBe('2500.00');
  });

  it('decrements totalSpent when a successful card payment disappears (FAIL)', async () => {
    const { service, transaction, card } = makeTransactionsService();
    transaction.findFirst.mockResolvedValue(SUCCESS_TX_ON_CARD);
    await service.update(USER_ID, TX_ID, { status: TransactionStatus.FAIL });
    const increment = card.update.mock.calls[0][0].data.totalSpent.increment as Prisma.Decimal;
    expect(increment.toFixed(2)).toBe('-2500.00');
  });

  it('adjusts totalSpent by the amount delta while both states are counted', async () => {
    const { service, transaction, card } = makeTransactionsService();
    transaction.findFirst.mockResolvedValue({
      ...TRANSACTION,
      cardId: CARD_ID,
      status: TransactionStatus.SUCCESS,
      amount: new Prisma.Decimal('1000.00'),
    });
    await service.update(USER_ID, TX_ID, { amount: '1200', status: TransactionStatus.SUCCESS });
    const increment = card.update.mock.calls[0][0].data.totalSpent.increment as Prisma.Decimal;
    expect(increment.toFixed(2)).toBe('200.00');
  });

  it('deletes an owned transaction and reports it', async () => {
    const { service, transaction } = makeTransactionsService();
    await expect(service.remove(USER_ID, TX_ID)).resolves.toEqual({
      deleted: true,
      id: TX_ID,
    });
    expect(transaction.delete).toHaveBeenCalledWith({ where: { id: TX_ID } });
  });

  it('decrements totalSpent when a successful card payment row is deleted', async () => {
    const { service, transaction, card } = makeTransactionsService();
    transaction.findFirst.mockResolvedValue(SUCCESS_TX_ON_CARD);
    await service.remove(USER_ID, TX_ID);
    const decrement = card.update.mock.calls[0][0].data.totalSpent.decrement as Prisma.Decimal;
    expect(decrement.toFixed(2)).toBe('2500.00');
  });
});

describe('ApprovalsService', () => {
  function makeApprovalsService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
    const transactionApproval = {
      findMany: vi.fn(async () => [APPROVAL_ROW]),
      count: vi.fn(async () => 1),
      findFirst: vi.fn(async () => APPROVAL_ROW),
      create: vi.fn(async (args) => ({ ...APPROVAL_ROW, ...args.data })),
      update: vi.fn(async (args) => ({ ...APPROVAL_ROW, ...args.data })),
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

  it('embeds the transaction details in the approval view', async () => {
    const { service } = makeApprovalsService();
    const result = await service.get(USER_ID, APPROVAL_ID);
    expect(result.transaction).toMatchObject({
      id: TX_ID,
      amount: '2500.00',
      type: TransactionType.PAYMENT,
    });
    expect(result.card).toBeNull();
  });

  it('embeds the card summary of the transaction’s card', async () => {
    const { service, transactionApproval } = makeApprovalsService();
    transactionApproval.findFirst.mockResolvedValue({
      ...APPROVAL_ROW,
      transaction: { ...TRANSACTION, cardId: CARD_ID, card: CARD_ROW },
    });
    const result = await service.get(USER_ID, APPROVAL_ID);
    expect(result.card).toEqual({
      id: CARD_ID,
      cardNumberLast4: '4242',
      cardType: 'virtual',
      createdAt: CARD_ROW.createdAt,
      totalSpent: '0.00',
    });
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
