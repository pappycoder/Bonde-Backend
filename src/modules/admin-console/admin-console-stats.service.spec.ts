import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminConsoleStatsService } from './admin-console-stats.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function mockPrisma() {
  return {
    profile: { count: vi.fn() },
    transaction: { count: vi.fn(), aggregate: vi.fn(), findMany: vi.fn() },
    supportTicket: { count: vi.fn() },
  } as unknown as PrismaService;
}

describe('AdminConsoleStatsService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('totals aggregate profile counts, SUCCESS volume and the review queue', async () => {
    const prisma = mockPrisma();
    (prisma.profile.count as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(128) // users
      .mockResolvedValueOnce(96) // active
      .mockResolvedValueOnce(24) // pending
      .mockResolvedValueOnce(8) // suspended
      .mockResolvedValueOnce(12) // new 30d
      .mockResolvedValueOnce(9); // new prev 30d
    (prisma.transaction.count as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(340) // success 30d
      .mockResolvedValueOnce(4); // pending reviews
    (prisma.transaction.aggregate as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ _sum: { amount: '250000.00' } }) // all-time
      .mockResolvedValueOnce({ _sum: { amount: '84000.00' } }) // 30d
      .mockResolvedValueOnce({ _sum: { amount: '62000.00' } }) // prev 30d
      .mockResolvedValueOnce({ _sum: { amount: '60000.00' } }) // deposits 30d
      .mockResolvedValueOnce({ _sum: { amount: '45000.00' } }); // deposits prev 30d
    (prisma.transaction.findMany as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    (prisma.supportTicket.count as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(5);

    const service = new AdminConsoleStatsService(prisma);
    const { totals } = await service.summary();

    expect(totals).toEqual({
      users: 128,
      activeUsers: 96,
      pendingUsers: 24,
      suspendedUsers: 8,
      newUsers30d: 12,
      newUsersPrev30d: 9,
      transactions30d: 340,
      volume: '250000.00',
      volume30d: '84000.00',
      volumePrev30d: '62000.00',
      deposits30d: '60000.00',
      depositsPrev30d: '45000.00',
      pendingReviews: 4,
      openTickets: 5,
    });
  });

  it('builds 12 month buckets oldest first, summing deposits and withdrawals', async () => {
    const prisma = mockPrisma();
    (prisma.profile.count as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.transaction.count as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.transaction.aggregate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      _sum: { amount: '0.00' },
    });
    (prisma.supportTicket.count as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.transaction.findMany as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { type: 'DEPOSIT', amount: '1200.5', createdAt: new Date('2026-09-02T10:00:00Z') },
        { type: 'WITHDRAWAL', amount: '400.00', createdAt: new Date('2026-09-10T10:00:00Z') },
        { type: 'PAYMENT', amount: '300.00', createdAt: new Date('2026-09-11T10:00:00Z') },
        { type: 'DEPOSIT', amount: '50.00', createdAt: new Date('2026-08-05T10:00:00Z') },
      ])
      .mockResolvedValueOnce([]);

    const service = new AdminConsoleStatsService(prisma);
    const { revenue } = await service.summary();

    expect(revenue).toHaveLength(12);
    expect(revenue.map((point) => point.month)).toEqual([
      'Oct',
      'Nov',
      'Dec',
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
    ]);
    expect(revenue[11]).toEqual({
      month: 'Sep',
      revenue: '1200.50',
      expenses: '400.00',
      volume: '1900.50',
    });
    expect(revenue[10].volume).toBe('50.00');
  });

  it('counts SUCCESS transactions per day over 7 trailing calendar days', async () => {
    const prisma = mockPrisma();
    (prisma.profile.count as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.transaction.count as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.transaction.aggregate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      _sum: { amount: '0.00' },
    });
    (prisma.supportTicket.count as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    const now = Date.now();
    (prisma.transaction.findMany as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { createdAt: new Date(now) },
        { createdAt: new Date(now) },
        { createdAt: new Date(now - 2 * 86_400_000) },
      ]);

    const service = new AdminConsoleStatsService(prisma);
    const { weekly } = await service.summary();

    expect(weekly).toHaveLength(7);
    expect(weekly.every((point) => point.transactions >= 0 && WEEKDAY.includes(point.day))).toBe(
      true,
    );
    expect(weekly.reduce((sum, point) => sum + point.transactions, 0)).toBe(3);
    expect(weekly[6].transactions).toBe(2);
  });

  it('passes derived status where-clauses to the profile counts', async () => {
    const prisma = mockPrisma();
    (prisma.profile.count as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.transaction.count as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.transaction.aggregate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      _sum: { amount: '0.00' },
    });
    (prisma.supportTicket.count as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.transaction.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const service = new AdminConsoleStatsService(prisma);
    await service.summary();
    const whereCalls = (prisma.profile.count as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { where?: Record<string, unknown> } | undefined)?.where ?? {},
    );
    const statusWheres = whereCalls.filter(
      (where) => 'emailVerified' in where || 'OR' in where || 'accounts' in where,
    );
    expect(statusWheres).toHaveLength(3);
    expect(statusWheres[0]).toMatchObject({ emailVerified: true });
  });
});
