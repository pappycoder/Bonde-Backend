import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminConsoleUsersService } from './admin-console-users.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const WALLET_ID = '44444444-4444-4444-8444-444444444444';
const TX_ID = '55555555-5555-4555-8555-555555555555';

function walletRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WALLET_ID,
    balance: '2500.00',
    currency: 'NGN',
    isActive: true,
    createdAt: new Date('2026-08-01T09:00:00.000Z'),
    updatedAt: new Date('2026-09-08T09:00:00.000Z'),
    ...overrides,
  };
}

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    accountNumber: '0123456789',
    accountType: 'CHECKING',
    isActive: true,
    createdAt: new Date('2026-08-01T09:00:00.000Z'),
    updatedAt: new Date('2026-08-01T09:00:00.000Z'),
    wallets: [walletRow()],
    ...overrides,
  };
}

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    fullName: 'Olivia Martin',
    email: 'olivia@bonde.ai',
    phone: '+2347000000000',
    phoneVerified: true,
    emailVerified: true,
    avatarUrl: null,
    onboardingCompletedAt: new Date('2026-08-01T09:00:00.000Z'),
    createdAt: new Date('2026-08-01T09:00:00.000Z'),
    updatedAt: new Date('2026-09-08T09:00:00.000Z'),
    accounts: [accountRow()],
    _count: { transactions: 4 },
    ...overrides,
  };
}

function recentTxRow() {
  return {
    id: TX_ID,
    userId: USER_ID,
    walletId: WALLET_ID,
    cardId: '66666666-6666-4666-8666-666666666666',
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
    card: { cardNumberLast4: '4242' },
    wallet: { currency: 'NGN' },
  };
}

function makeService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const profile = {
    findMany: vi.fn(async () => [profileRow()]),
    findUnique: vi.fn(async () => profileRow()),
    count: vi.fn(async () => 1),
    ...overrides.profile,
  };
  const transaction = {
    findMany: vi.fn(async () => [recentTxRow()]),
    ...overrides.transaction,
  };
  const account = {
    update: vi.fn(async (): Promise<unknown> => ({ id: ACCOUNT_ID })),
    ...overrides.account,
  };
  const wallet = {
    update: vi.fn(async (): Promise<unknown> => ({ id: WALLET_ID })),
    ...overrides.wallet,
  };
  const audit = {
    record: vi.fn(async (): Promise<void> => undefined),
    ...overrides.audit,
  };
  const prisma = {
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    profile,
    transaction,
    account,
    wallet,
  };
  const service = new AdminConsoleUsersService(prisma as never, audit as never);
  return { service, profile, transaction, account, wallet, audit };
}

describe('AdminConsoleUsersService', () => {
  it('lists a paged envelope newest-first with the user include', async () => {
    const { service, profile } = makeService();
    const result = await service.list({ page: 2, pageSize: 10 });
    expect(result).toMatchObject({ total: 1, page: 2, pageSize: 10, totalPages: 1 });
    expect(profile.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
      skip: 10,
      take: 10,
      include: {
        accounts: { include: { wallets: true } },
        _count: { select: { transactions: true } },
      },
    });
  });

  it('combines search, status and field filters into an AND', async () => {
    const { service, profile } = makeService();
    await service.list({ q: 'oliv', status: 'suspended', filter: 'emailVerified:true' });
    const where = profile.findMany.mock.calls[0][0].where;
    expect(where.AND).toHaveLength(3);
    expect(where.AND[0]).toEqual({ emailVerified: true });
    expect(where.AND[1].OR).toEqual([
      { fullName: { contains: 'oliv', mode: 'insensitive' } },
      { email: { contains: 'oliv', mode: 'insensitive' } },
      { phone: { contains: 'oliv', mode: 'insensitive' } },
    ]);
    expect(where.AND[2].OR).toHaveLength(2);
  });

  it('derives the active status for a fully provisioned user', async () => {
    const { service } = makeService();
    const detail = await service.get(USER_ID);
    expect(detail).toMatchObject({
      status: 'active',
      balance: '2500.00',
      currency: 'NGN',
      accountNumber: '0123456789',
      isActive: true,
      onboardingCompleted: true,
      transactionCount: 4,
    });
  });

  it('derives pending when email is unverified or no account exists', async () => {
    const { service, profile } = makeService();
    profile.findUnique.mockResolvedValue(profileRow({ emailVerified: false }));
    const unverified = await service.get(USER_ID);
    expect(unverified.status).toBe('pending');

    profile.findUnique.mockResolvedValue(profileRow({ accounts: [] }));
    const noAccount = await service.get(USER_ID);
    expect(noAccount.status).toBe('pending');
  });

  it('derives suspended when the account or wallet is inactive', async () => {
    const { service, profile } = makeService();
    profile.findUnique.mockResolvedValue(
      profileRow({ accounts: [accountRow({ isActive: false })] }),
    );
    await expect(service.get(USER_ID)).resolves.toMatchObject({ status: 'suspended' });
  });

  it('404s for an unknown user', async () => {
    const { service, profile } = makeService();
    profile.findUnique.mockResolvedValue(null);
    await expect(service.get(OTHER_ID)).rejects.toThrow(NotFoundException);
  });

  it('serializes recent transactions with money and a card method', async () => {
    const { service } = makeService();
    const detail = await service.get(USER_ID);
    expect(detail.recentTransactions).toHaveLength(1);
    expect(detail.recentTransactions[0]).toMatchObject({
      id: TX_ID,
      amount: '2500.00',
      status: 'completed',
      type: 'payment',
      method: 'Card •••• 4242',
    });
  });

  it('resolves names to a map', async () => {
    const { service, profile } = makeService();
    profile.findMany.mockResolvedValue([
      { id: USER_ID, fullName: 'Olivia Martin' },
      { id: OTHER_ID, fullName: 'Jackson Lee' },
    ]);
    const result = await service.names(`${USER_ID}, ${OTHER_ID}`);
    expect(profile.findMany).toHaveBeenCalledWith({
      where: { id: { in: [USER_ID, OTHER_ID] } },
      select: { id: true, fullName: true },
    });
    expect(result).toEqual({
      [USER_ID]: 'Olivia Martin',
      [OTHER_ID]: 'Jackson Lee',
    });
  });

  it('returns an empty map for a blank ids input', async () => {
    const { service } = makeService();
    await expect(service.names(' , ,')).resolves.toEqual({});
  });

  it('rejects more than 500 ids at once', async () => {
    const { service } = makeService();
    const many = Array.from({ length: 501 }, () => USER_ID).join(',');
    await expect(service.names(many)).rejects.toThrow(BadRequestException);
  });

  it('rejects non-UUID ids', async () => {
    const { service } = makeService();
    await expect(service.names('USR-1042')).rejects.toThrow(BadRequestException);
  });
});

describe('AdminConsoleUsersService.suspend / restore', () => {
  it('suspends by deactivating the account + wallet and records the audit', async () => {
    const { service, profile, account, wallet, audit } = makeService();
    profile.findUnique.mockResolvedValueOnce(profileRow()).mockResolvedValue(
      profileRow({
        accounts: [accountRow({ isActive: false, wallets: [walletRow({ isActive: false })] })],
      }),
    );

    const result = await service.suspend(USER_ID, ACTOR_ID, 'Repeated risk failures');

    expect(account.update).toHaveBeenCalledWith({
      where: { id: ACCOUNT_ID },
      data: { isActive: false },
    });
    expect(wallet.update).toHaveBeenCalledWith({
      where: { id: WALLET_ID },
      data: { isActive: false },
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith({
      userId: ACTOR_ID,
      action: 'admin.users.suspend',
      entityType: 'user',
      entityId: USER_ID,
      metadata: { reason: 'Repeated risk failures' },
    });
    expect(result).toMatchObject({ id: USER_ID, status: 'suspended' });
  });

  it('restores by reactivating the account + wallet and records the audit', async () => {
    const { service, profile, account, wallet, audit } = makeService();
    profile.findUnique
      .mockResolvedValueOnce(profileRow({ accounts: [accountRow({ isActive: false })] }))
      .mockResolvedValue(profileRow());

    const result = await service.restore(USER_ID, ACTOR_ID);

    expect(account.update).toHaveBeenCalledWith({
      where: { id: ACCOUNT_ID },
      data: { isActive: true },
    });
    expect(wallet.update).toHaveBeenCalledWith({
      where: { id: WALLET_ID },
      data: { isActive: true },
    });
    expect(audit.record).toHaveBeenCalledWith({
      userId: ACTOR_ID,
      action: 'admin.users.restore',
      entityType: 'user',
      entityId: USER_ID,
      metadata: undefined,
    });
    expect(result).toMatchObject({ id: USER_ID, status: 'active' });
  });

  it('is an idempotent no-op when the user is already suspended', async () => {
    const { service, profile, account, wallet, audit } = makeService();
    profile.findUnique.mockResolvedValue(
      profileRow({ accounts: [accountRow({ isActive: false })] }),
    );

    const result = await service.suspend(USER_ID, ACTOR_ID);

    expect(result).toMatchObject({ status: 'suspended' });
    expect(account.update).not.toHaveBeenCalled();
    expect(wallet.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('404s for an unknown user', async () => {
    const { service, profile } = makeService();
    profile.findUnique.mockResolvedValue(null);
    await expect(service.suspend(OTHER_ID, ACTOR_ID)).rejects.toThrow(NotFoundException);
    await expect(service.restore(OTHER_ID, ACTOR_ID)).rejects.toThrow(NotFoundException);
  });

  it('409s when the user has no provisioned account', async () => {
    const { service, profile, audit } = makeService();
    profile.findUnique.mockResolvedValue(profileRow({ accounts: [] }));
    await expect(service.suspend(USER_ID, ACTOR_ID)).rejects.toThrow(ConflictException);
    await expect(service.restore(USER_ID, ACTOR_ID)).rejects.toThrow(ConflictException);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
