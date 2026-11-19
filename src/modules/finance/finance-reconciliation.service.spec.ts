import { describe, expect, it, vi } from 'vitest';
import { FinanceReconciliation } from './finance-reconciliation.service.js';

describe('settlement liquidity coverage', () => {
  it('checks every distinct programme and historical settlement without summing linked assets', async () => {
    const sudo = {
      call: vi.fn(async (path: string) => {
        if (path.includes('unavailable')) throw new Error('Provider unavailable');
        return { availableBalance: '123.45' };
      }),
    };
    const service = new FinanceReconciliation(
      {
        $queryRaw: vi.fn(async () => [
          { currency: 'NGN', id: 'historical', brand: 'Visa' },
          { currency: 'NGN', id: 'shared', brand: 'Verve' },
        ]),
      } as never,
      {
        call: vi.fn(async () => [{ accountNumber: 'treasury', availableBalance: 123.45 }]),
      } as never,
      sudo as never,
      {
        get: () => ({
          treasuryAccountNumber: 'treasury',
          ngnSettlementId: 'legacy',
          ngnCardProgrammes: [
            { brand: 'Verve', settlementId: 'shared' },
            { brand: 'MasterCard', settlementId: 'shared' },
            { brand: 'Visa', settlementId: 'unavailable' },
          ],
        }),
      } as never,
    );
    const result = await service.liquidity();
    expect(sudo.call).toHaveBeenCalledTimes(4);
    expect(result.snapshots.find((s) => s.accountId === 'shared')?.brands).toEqual([
      'Verve',
      'MasterCard',
    ]);
    expect(result.snapshots.find((s) => s.accountId === 'unavailable')?.available).toBeNull();
    expect(result.snapshots.find((s) => s.accountId === 'historical')?.available).toBe('123.45');
    expect(result.overlapPossible).toBe(true);
    expect(result).not.toHaveProperty('total');
  });
});
