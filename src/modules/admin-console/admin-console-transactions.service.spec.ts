import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ApprovalStatus, TransactionStatus, TransactionType } from '@prisma/client';
import { AdminConsoleTransactionsService } from './admin-console-transactions.service.js';
import { deriveTxStatus, toAdminTxSummary, txMethod } from './admin-tx-view.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const WALLET_ID = '77777777-7777-4777-8777-777777777777';
const TX_ID = '66666666-6666-4666-8666-666666666666';

interface TxSource {
  id: string;
  userId: string;
  walletId: string;
  cardId: string | null;
  chatId: string | null;
  type: TransactionType;
  status: TransactionStatus;
  approvalStatus: ApprovalStatus;
  amount: string;
  currency: string;
  description: string | null;
  metadata: Record<string, never>;
  frequency: string;
  isRecurring: boolean;
  recurrenceEndDate: null;
  nextOccurrenceDate: null;
  thresholdWarning: boolean;
  approvalNotes: null;
  approvedAt: null;
  createdAt: Date;
  updatedAt: Date;
}

function txRow(overrides: Partial<TxSource> = {}): TxSource {
  return {
    id: TX_ID,
    userId: USER_ID,
    walletId: WALLET_ID,
    cardId: null,
    chatId: null,
    type: 'PAYMENT',
    status: 'SUCCESS',
    approvalStatus: 'APPROVED',
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
    createdAt: new Date('2026-09-08T09:42:00.000Z'),
    updatedAt: new Date('2026-09-08T09:42:00.000Z'),
    ...overrides,
  };
}

function listRow(overrides: Partial<TxSource> = {}) {
  return {
    ...txRow(overrides),
    user: { fullName: 'Olivia Martin', email: 'olivia@bonde.ai' },
    wallet: { currency: 'NGN' },
    card: { cardNumberLast4: '4242' },
  };
}

function detailRow(overrides: Partial<TxSource> = {}) {
  return {
    ...txRow(overrides),
    user: { id: USER_ID, fullName: 'Olivia Martin', email: 'olivia@bonde.ai' },
    wallet: { id: WALLET_ID, balance: '10000.00', currency: 'NGN', isActive: true },
    card: null,
    approvals: [
      {
        id: '88888888-8888-4888-8888-888888888888',
        status: 'APPROVED',
        approvedBy: USER_ID,
        notes: 'ok',
        createdAt: new Date('2026-09-08T09:41:00.000Z'),
        approver: { id: USER_ID, fullName: 'Olivia Martin' },
      },
    ],
    providerEvents: [
      {
        id: '99999999-9999-4999-8999-999999999999',
        provider: 'flutterwave',
        reference: 'bonde_wd_1',
        eventType: 'transfer.disburse',
        status: 'PROCESSED',
        processedAt: new Date('2026-09-08T09:42:00.000Z'),
        createdAt: new Date('2026-09-08T09:42:00.000Z'),
      },
    ],
  };
}

function makeService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const transaction = {
    findMany: vi.fn(async () => [listRow()]),
    count: vi.fn(async () => 1),
    findUnique: vi.fn(async () => detailRow()),
    update: vi.fn(async (): Promise<unknown> => ({ id: TX_ID })),
    ...overrides.transaction,
  };
  const transactionApproval = {
    create: vi.fn(async (): Promise<unknown> => ({ id: TX_ID })),
    ...overrides.transactionApproval,
  };
  const audit = {
    record: vi.fn(async (): Promise<void> => undefined),
    ...overrides.audit,
  };
  const prisma = {
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    transaction,
    transactionApproval,
  };
  const service = new AdminConsoleTransactionsService(prisma as never, audit as never);
  return { service, transaction, transactionApproval, audit };
}

describe('AdminConsoleTransactionsService', () => {
  it('lists a paged envelope newest-first with the user include', async () => {
    const { service, transaction } = makeService();
    const result = await service.list({ page: 1, pageSize: 25 });
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {},
        orderBy: { createdAt: 'desc' },
        take: 25,
        include: expect.objectContaining({ user: expect.anything(), wallet: expect.anything() }),
      }),
    );
  });

  it('applies raw enum filters', async () => {
    const { service, transaction } = makeService();
    await service.list({ filter: ['status:SUCCESS', 'type:PAYMENT'] });
    const where = transaction.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('SUCCESS');
    expect(where.type).toBe('PAYMENT');
  });

  it('searches description, user name and user email', async () => {
    const { service, transaction } = makeService();
    await service.list({ q: 'oliv' });
    const where = transaction.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { description: { contains: 'oliv', mode: 'insensitive' } },
      { user: { fullName: { contains: 'oliv', mode: 'insensitive' } } },
      { user: { email: { contains: 'oliv', mode: 'insensitive' } } },
    ]);
  });

  it('embeds the user identity and normalized money in list rows', async () => {
    const { service } = makeService();
    const result = await service.list({});
    expect(result.items[0]).toMatchObject({
      id: TX_ID,
      user: 'Olivia Martin',
      userEmail: 'olivia@bonde.ai',
      amount: '2500.00',
      type: 'payment',
      currency: 'NGN',
    });
  });

  it('returns the full detail with wallet money, approval names and provider events', async () => {
    const { service } = makeService();
    const detail = await service.get(TX_ID);
    expect(detail).toMatchObject({
      id: TX_ID,
      wallet: { id: WALLET_ID, balance: '10000.00' },
      card: null,
      approvals: [
        {
          status: 'APPROVED',
          approver: 'Olivia Martin',
          notes: 'ok',
        },
      ],
      providerEvents: [
        {
          reference: 'bonde_wd_1',
          eventType: 'transfer.disburse',
          processedAt: '2026-09-08T09:42:00.000Z',
        },
      ],
    });
  });

  it('404s for an unknown transaction', async () => {
    const { service, transaction } = makeService();
    transaction.findUnique.mockResolvedValue(null);
    await expect(service.get(TX_ID)).rejects.toThrow(NotFoundException);
  });
});

describe('AdminConsoleTransactionsService.review', () => {
  it('approves by recording the approval row and marking the transaction', async () => {
    const { service, transaction, transactionApproval, audit } = makeService();
    transaction.findUnique
      .mockResolvedValueOnce(txRow({ status: 'PENDING', approvalStatus: 'PENDING' }))
      .mockResolvedValue(detailRow());

    const result = await service.review(TX_ID, ACTOR_ID, { status: 'APPROVED', notes: 'ok' });

    expect(transactionApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        transactionId: TX_ID,
        status: 'APPROVED',
        approvedBy: ACTOR_ID,
        notes: 'ok',
      }),
    });
    expect(transaction.update).toHaveBeenCalledWith({
      where: { id: TX_ID },
      data: {
        approvalStatus: 'APPROVED',
        approvedAt: expect.any(Date),
        approvalNotes: 'ok',
      },
    });
    expect(audit.record).toHaveBeenCalledWith({
      userId: ACTOR_ID,
      action: 'admin.transactions.approve',
      entityType: 'transaction',
      entityId: TX_ID,
      metadata: { notes: 'ok' },
    });
    expect(result).toMatchObject({ id: TX_ID });
  });

  it('declines by setting the DECLINED state without an approval timestamp', async () => {
    const { service, transaction, transactionApproval, audit } = makeService();
    transaction.findUnique
      .mockResolvedValueOnce(txRow({ status: 'PENDING', approvalStatus: 'PENDING' }))
      .mockResolvedValue(detailRow());

    await service.review(TX_ID, ACTOR_ID, { status: 'DECLINED' });

    expect(transactionApproval.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DECLINED', notes: null }),
      }),
    );
    expect(transaction.update).toHaveBeenCalledWith({
      where: { id: TX_ID },
      data: { approvalStatus: 'DECLINED', approvedAt: null },
    });
    expect(audit.record).toHaveBeenCalledWith({
      userId: ACTOR_ID,
      action: 'admin.transactions.decline',
      entityType: 'transaction',
      entityId: TX_ID,
      metadata: undefined,
    });
  });

  it('404s for an unknown transaction', async () => {
    const { service, transaction, transactionApproval, audit } = makeService();
    transaction.findUnique.mockResolvedValue(null);
    await expect(service.review(TX_ID, ACTOR_ID, { status: 'APPROVED' })).rejects.toThrow(
      NotFoundException,
    );
    expect(transactionApproval.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('409s once the transaction is settled', async () => {
    const { service, transaction, transactionApproval, audit } = makeService();
    transaction.findUnique.mockResolvedValue(txRow({ status: 'SUCCESS' }));
    await expect(service.review(TX_ID, ACTOR_ID, { status: 'APPROVED' })).rejects.toThrow(
      ConflictException,
    );
    expect(transactionApproval.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('409s once a decision already landed', async () => {
    const { service, transaction, transactionApproval, audit } = makeService();
    transaction.findUnique.mockResolvedValue(
      txRow({ status: 'PENDING', approvalStatus: 'APPROVED' }),
    );
    await expect(service.review(TX_ID, ACTOR_ID, { status: 'DECLINED' })).rejects.toThrow(
      ConflictException,
    );
    expect(transactionApproval.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('admin-tx-view', () => {
  it('derives the legacy dashboard statuses', () => {
    const base = {
      status: 'PENDING' as const,
      approvalStatus: 'PENDING' as const,
      thresholdWarning: false,
    };
    expect(deriveTxStatus({ ...base, status: 'SUCCESS' })).toBe('completed');
    expect(deriveTxStatus({ ...base, status: 'FAIL' })).toBe('failed');
    expect(deriveTxStatus(base)).toBe('processing');
    expect(deriveTxStatus({ ...base, approvalStatus: 'APPROVED' })).toBe('pending');
    expect(deriveTxStatus({ ...base, approvalStatus: 'DECLINED' })).toBe('failed');
    expect(deriveTxStatus({ ...base, thresholdWarning: true })).toBe('flagged');
    expect(deriveTxStatus({ ...base, status: 'SUCCESS', thresholdWarning: true })).toBe('flagged');
  });

  it('picks the method from the card or the movement type', () => {
    expect(txMethod({ type: 'PAYMENT', cardId: 'c1', cardNumberLast4: '4242' })).toBe(
      'Card •••• 4242',
    );
    expect(txMethod({ type: 'DEPOSIT', cardId: null })).toBe('Bank transfer');
    expect(txMethod({ type: 'WITHDRAWAL', cardId: null })).toBe('Bank transfer');
    expect(txMethod({ type: 'PAYMENT', cardId: null })).toBe('Bonde Pay');
    expect(txMethod({ type: 'TRANSFER', cardId: null })).toBe('Wallet transfer');
  });

  it('serializes a transaction summary to its view', () => {
    const row = txRow({ cardId: '66666666-6666-4666-8666-666666666666' });
    const view = toAdminTxSummary({ ...row, card: { cardNumberLast4: '4242' } }, 'NGN');
    expect(view).toMatchObject({
      id: TX_ID,
      type: 'payment',
      status: 'completed',
      amount: '2500.00',
      currency: 'NGN',
      method: 'Card •••• 4242',
      createdAt: '2026-09-08T09:42:00.000Z',
    });
  });
});
