import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminConsoleStatsService } from './admin-console-stats.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

const DAY_MS = 86_400_000;
const NOW_ISO = '2026-09-15T12:00:00.000Z';

type TxWhere = {
  status?: string;
  type?: string;
  createdAt?: { gte: Date; lt: Date };
};

function mockPrisma() {
  return {
    profile: { count: vi.fn() },
    transaction: { count: vi.fn(), aggregate: vi.fn(), findMany: vi.fn() },
    supportTicket: { count: vi.fn() },
  } as unknown as PrismaService;
}

function mocks(prisma: PrismaService) {
  return prisma as unknown as {
    profile: { count: ReturnType<typeof vi.fn> };
    transaction: {
      count: ReturnType<typeof vi.fn>;
      aggregate: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
    supportTicket: { count: ReturnType<typeof vi.fn> };
  };
}

/** Zero-everything baseline; individual tests override what they care about. */
function stub(prisma: PrismaService) {
  const { profile, transaction, supportTicket } = mocks(prisma);
  profile.count.mockResolvedValue(0);
  transaction.count.mockResolvedValue(0);
  transaction.aggregate.mockResolvedValue({ _sum: { amount: '0.00' } });
  transaction.findMany.mockResolvedValue([]);
  supportTicket.count.mockResolvedValue(0);
}

/** Start of the trailing window for `days`, matching the service's arithmetic. */
const windowStart = (days: number) => Date.now() - days * DAY_MS;

/**
 * The `createdAt` bounds of a `profile.count` call, or undefined when the call
 * was a state gauge (those carry a status where-clause, not a date range).
 */
function createdAtWindow(
  prisma: PrismaService,
  nth: number,
): { gte: string; lt: string } | undefined {
  const where = mocks(prisma).profile.count.mock.calls[nth]?.[0]?.where as
    { createdAt?: { gte: Date; lt: Date } } | undefined;
  if (!where?.createdAt) return undefined;
  return { gte: where.createdAt.gte.toISOString(), lt: where.createdAt.lt.toISOString() };
}

describe('AdminConsoleStatsService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps state gauges all-time and scopes period metrics to the window', async () => {
    const prisma = mockPrisma();
    const { profile, transaction, supportTicket } = mocks(prisma);
    stub(prisma);

    // State gauges: users, active, pending, suspended — in call order.
    profile.count
      .mockResolvedValueOnce(128)
      .mockResolvedValueOnce(96)
      .mockResolvedValueOnce(24)
      .mockResolvedValueOnce(8)
      // Then the two registration deltas, keyed off their window start.
      .mockImplementation((args: { where?: { createdAt?: { gte: Date } } }) =>
        Promise.resolve(args.where?.createdAt?.gte.getTime() === windowStart(30) ? 12 : 9),
      );

    // Keyed off the where-clause, not call order: the review-queue count and
    // the window transaction count are issued in separate parallel batches.
    transaction.count.mockImplementation((args: { where?: TxWhere }) =>
      Promise.resolve(args.where?.status === 'PENDING' ? 4 : 340),
    );
    transaction.aggregate.mockImplementation((args: { where?: TxWhere }) => {
      const { type, createdAt } = args.where ?? {};
      if (!createdAt) return Promise.resolve({ _sum: { amount: '250000.00' } });
      const current = createdAt.gte.getTime() === windowStart(30);
      if (type === 'DEPOSIT') {
        return Promise.resolve({
          _sum: { amount: current ? '60000.00' : '45000.00' },
        });
      }
      return Promise.resolve({
        _sum: { amount: current ? '84000.00' : '62000.00' },
      });
    });
    supportTicket.count.mockResolvedValue(5);

    const { totals, windowTotals } = await new AdminConsoleStatsService(prisma).summary();

    expect(totals).toEqual({
      users: 128,
      activeUsers: 96,
      pendingUsers: 24,
      suspendedUsers: 8,
      pendingReviews: 4,
      openTickets: 5,
      volume: '250000.00',
    });
    expect(windowTotals).toEqual({
      newUsers: 12,
      newUsersPrev: 9,
      transactions: 340,
      volume: '84000.00',
      volumePrev: '62000.00',
      deposits: '60000.00',
      depositsPrev: '45000.00',
    });
  });

  it('defaults to a 30-day window and echoes the resolved bounds', async () => {
    const prisma = mockPrisma();
    stub(prisma);

    const { window } = await new AdminConsoleStatsService(prisma).summary();

    expect(window.days).toBe(30);
    expect(window.from).toBe(new Date(windowStart(30)).toISOString());
    expect(window.to).toBe(NOW_ISO);
  });

  it('scopes the current and preceding windows adjacently, with no gap or overlap', async () => {
    const prisma = mockPrisma();
    stub(prisma);

    await new AdminConsoleStatsService(prisma).summary(7);

    // Calls 0-3 are the state gauges; 4 and 5 are the registration deltas.
    const current = createdAtWindow(prisma, 4);
    const previous = createdAtWindow(prisma, 5);
    expect(current).toEqual({
      gte: new Date(windowStart(7)).toISOString(),
      lt: NOW_ISO,
    });
    expect(previous?.lt).toBe(current?.gte);
    expect(previous?.gte).toBe(new Date(windowStart(14)).toISOString());
  });

  it('buckets the series by day for windows up to 31 days', async () => {
    const prisma = mockPrisma();
    const { transaction } = mocks(prisma);
    stub(prisma);
    transaction.findMany.mockResolvedValueOnce([
      { type: 'DEPOSIT', amount: '1200.50', createdAt: new Date('2026-09-14T10:00:00Z') },
      { type: 'WITHDRAWAL', amount: '400.00', createdAt: new Date('2026-09-14T22:00:00Z') },
      { type: 'PAYMENT', amount: '300.00', createdAt: new Date('2026-09-10T10:00:00Z') },
    ]);

    const { series } = await new AdminConsoleStatsService(prisma).summary(30);

    // A 30-day trailing window touches 31 calendar days, the last one partial.
    expect(series).toHaveLength(31);
    expect(series[0].label).toBe('Aug 16');
    expect(series.at(-1)?.label).toBe('Sep 15');
    // Both September rows collapse into one day bucket.
    expect(series.find((point) => point.label === 'Sep 14')).toEqual({
      label: 'Sep 14',
      revenue: '1200.50',
      expenses: '400.00',
      volume: '1600.50',
      transactions: 2,
    });
    expect(series.find((point) => point.label === 'Sep 10')?.transactions).toBe(1);
    // A day with no movement is still present, so the x-axis has no gaps.
    expect(series.find((point) => point.label === 'Sep 11')?.transactions).toBe(0);
    // Today is a partial bucket, and it is present rather than dropped.
    expect(series.at(-1)).toMatchObject({ label: 'Sep 15', transactions: 0 });
  });

  it('buckets the series by month beyond 31 days, labelling the year', async () => {
    const prisma = mockPrisma();
    const { transaction } = mocks(prisma);
    stub(prisma);
    transaction.findMany.mockResolvedValueOnce([
      { type: 'DEPOSIT', amount: '1200.50', createdAt: new Date('2026-09-02T10:00:00Z') },
      { type: 'DEPOSIT', amount: '50.00', createdAt: new Date('2026-08-05T10:00:00Z') },
      { type: 'WITHDRAWAL', amount: '400.00', createdAt: new Date('2026-09-10T10:00:00Z') },
    ]);

    const { series } = await new AdminConsoleStatsService(prisma).summary(365);

    // A 365-day trailing window touches at most 13 calendar months.
    expect(series).toHaveLength(13);
    expect(series.map((point) => point.label)).toEqual([
      'Sep 25',
      'Oct 25',
      'Nov 25',
      'Dec 25',
      'Jan 26',
      'Feb 26',
      'Mar 26',
      'Apr 26',
      'May 26',
      'Jun 26',
      'Jul 26',
      'Aug 26',
      'Sep 26',
    ]);
    // Both September buckets share a name, so the year keeps them distinct.
    expect(series.at(-1)).toEqual({
      label: 'Sep 26',
      revenue: '1200.50',
      expenses: '400.00',
      volume: '1600.50',
      transactions: 2,
    });
    expect(series.at(-2)?.volume).toBe('50.00');
  });

  it('reads the series from a single window-scoped query', async () => {
    const prisma = mockPrisma();
    const { transaction } = mocks(prisma);
    stub(prisma);

    await new AdminConsoleStatsService(prisma).summary(30);

    expect(transaction.findMany).toHaveBeenCalledTimes(1);
    const where = transaction.findMany.mock.calls[0][0].where as {
      status: string;
      createdAt: { gte: Date; lt: Date };
    };
    expect(where.status).toBe('SUCCESS');
    expect(where.createdAt.gte.toISOString()).toBe(new Date(windowStart(30)).toISOString());
    expect(where.createdAt.lt.toISOString()).toBe(NOW_ISO);
  });
});
