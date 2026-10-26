import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { FinanceRetirement } from './finance-retirement.service.js';
const d = (n: number) => new Prisma.Decimal(n);
function setup({ held = 0, unresolved = 0, remoteStatus = 'active' } = {}) {
  const card = {
    id: 'card',
    userId: 'owner',
    externalReferenceId: 'remote',
    currency: 'NGN',
    retiredAt: new Date(),
    retirementReason: 'USAGE_LIMIT',
    retirementStatus: 'RETIRING',
  };
  const tx = {
    $queryRaw: vi.fn(),
    card: {
      findUniqueOrThrow: vi.fn(async () => card),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    financeAuthorization: { count: vi.fn(async () => held) },
    financeInbox: { count: vi.fn(async () => unresolved) },
    financeAccount: { findUnique: vi.fn(async () => ({ key: 'card:card:NGN', balance: d(0) })) },
    financeOperation: { update: vi.fn() },
    cardHistory: { create: vi.fn() },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)) };
  const sudo = {
    call: vi.fn(async (_path: string, method?: string) => {
      if (method === 'PUT') remoteStatus = 'inactive';
      return { _id: 'remote', status: remoteStatus };
    }),
  };
  const ledger = { post: vi.fn() };
  return {
    tx,
    sudo,
    ledger,
    card,
    service: new FinanceRetirement(db as never, {} as never, ledger as never, sudo as never),
  };
}
const op = { id: 'operation', cardId: 'card', userId: 'owner' };
describe('permanent retirement provider coordination', () => {
  it('deactivates normally without falsely reporting loss/theft or claiming cancellation', async () => {
    const { service, sudo, tx } = setup();
    await service.process(op as never);
    expect(sudo.call).toHaveBeenCalledWith('/cards/remote', 'PUT', { status: 'inactive' });
    expect(tx.financeOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUCCEEDED',
          result: { providerStatus: 'inactive', providerCancellation: 'UNSUPPORTED_NORMAL_REASON' },
        }),
      }),
    );
    expect(tx.card.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'card', providerLeaseOwner: 'operation' },
        data: { providerLeaseOwner: null, providerLeaseUntil: null },
      }),
    );
  });
  it.each([{ held: 1 }, { unresolved: 1 }])(
    'waits for verified settlement/reconciliation before returning allocation: %o',
    async (condition) => {
      const { service, tx, ledger } = setup(condition);
      await service.process(op as never);
      expect(ledger.post).not.toHaveBeenCalled();
      expect(tx.financeOperation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PENDING',
            result: expect.objectContaining({ reason: 'WAITING_FOR_SETTLEMENT' }),
          }),
        }),
      );
      expect(tx.card.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ retirementStatus: 'RETIRED' }) }),
      );
    },
  );
  it('retries reads without another deactivation once provider inactivity is confirmed', async () => {
    const { service, sudo } = setup({ remoteStatus: 'inactive' });
    await service.process(op as never);
    expect(sudo.call).toHaveBeenCalledTimes(1);
  });
  it('leaves an uncertain deactivation reserved when provider confirmation fails', async () => {
    const { service, sudo, tx, ledger } = setup();
    sudo.call.mockRejectedValueOnce(new Error('timeout'));
    await service.process(op as never);
    expect(tx.financeOperation.update).toHaveBeenCalledWith({
      where: { id: 'operation' },
      data: {
        status: 'UNKNOWN',
        leaseUntil: null,
        result: { reason: 'DEACTIVATION_OR_RECONCILIATION_REQUIRED' },
      },
    });
    expect(ledger.post).not.toHaveBeenCalled();
  });
});

describe('queued reactivation after permanent retirement', () => {
  it('supersedes a stale resume before sending any provider write', async () => {
    const { FinanceWorker } = await import('./finance-worker.service.js');
    const prisma = {
      financeOperation: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({ id: 'resume', kind: 'RESUME', cardId: 'card' })),
        update: vi.fn(),
      },
      card: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: 'card',
          userId: 'owner',
          externalReferenceId: 'remote',
          retiredAt: new Date(),
        })),
      },
    };
    const sudo = { call: vi.fn() };
    const retirement = { lease: vi.fn(), release: vi.fn(), ensureDue: vi.fn() };
    const policy = { snapshot: vi.fn(async () => ({ reason: 'USAGE_LIMIT' })) };
    const worker = new FinanceWorker(
      prisma as never,
      {} as never,
      sudo as never,
      {} as never,
      {} as never,
      {} as never,
      retirement as never,
      policy as never,
    );
    await worker.process('resume');
    expect(sudo.call).not.toHaveBeenCalled();
    expect(prisma.financeOperation.update).toHaveBeenCalledWith({
      where: { id: 'resume' },
      data: { status: 'SUPERSEDED', leaseUntil: null },
    });
    expect(retirement.ensureDue).toHaveBeenCalledWith('owner', 'card');
    expect(retirement.release).toHaveBeenCalledWith('card', 'resume');
  });
});
