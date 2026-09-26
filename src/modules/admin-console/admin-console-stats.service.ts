import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { money } from '../../common/money/money.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { statusWhere } from './admin-console-users.service.js';

const DAY_MS = 86_400_000;

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export interface AdminRevenuePoint {
  month: string;
  /** DEPOSITS in SUCCESS that month, fixed 2-decimal string. */
  revenue: string;
  /** WITHDRAWALS in SUCCESS that month, fixed 2-decimal string. */
  expenses: string;
  /** All SUCCESS volume that month, fixed 2-decimal string. */
  volume: string;
}

export interface AdminWeeklyPoint {
  day: string;
  transactions: number;
}

export interface AdminStatsSummary {
  totals: {
    users: number;
    activeUsers: number;
    pendingUsers: number;
    suspendedUsers: number;
    newUsers30d: number;
    newUsersPrev30d: number;
    transactions30d: number;
    volume: string;
    volume30d: string;
    volumePrev30d: string;
    deposits30d: string;
    depositsPrev30d: string;
    pendingReviews: number;
  };
  /** Last 12 completed months, oldest first. */
  revenue: AdminRevenuePoint[];
  /** Last 7 calendar days (oldest first). */
  weekly: AdminWeeklyPoint[];
}

/**
 * Dashboard/analytics KPIs for the admin console. All money is `SUCCESS`
 * volume in NGN (fixed 2-decimal strings via `money()`); the 30-day windows
 * are trailing, so `volume30d` vs `volumePrev30d` (and the user-registration
 * pair) give the dashboard its deltas. Series are built from scoped reads and
 * bucketed in JS — cheap at dashboard scale and keeps SQL simple.
 */
@Injectable()
export class AdminConsoleStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(): Promise<AdminStatsSummary> {
    const now = Date.now();
    const window30 = new Date(now - 30 * DAY_MS);
    const window60 = new Date(now - 60 * DAY_MS);

    const users = await this.prisma.profile.count();
    const activeUsers = await this.prisma.profile.count({ where: statusWhere('active') });
    const pendingUsers = await this.prisma.profile.count({ where: statusWhere('pending') });
    const suspendedUsers = await this.prisma.profile.count({ where: statusWhere('suspended') });
    const newUsers30d = await this.prisma.profile.count({
      where: { createdAt: { gte: window30 } },
    });
    const newUsersPrev30d = await this.prisma.profile.count({
      where: { createdAt: { gte: window60, lt: window30 } },
    });

    const SUCCESS: Prisma.TransactionWhereInput = { status: 'SUCCESS' };
    const transactions30d = await this.prisma.transaction.count({
      where: { ...SUCCESS, createdAt: { gte: window30 } },
    });
    const volumeAll = await this.prisma.transaction.aggregate({
      where: SUCCESS,
      _sum: { amount: true },
    });
    const volume30d = await this.prisma.transaction.aggregate({
      where: { ...SUCCESS, createdAt: { gte: window30 } },
      _sum: { amount: true },
    });
    const volumePrev30d = await this.prisma.transaction.aggregate({
      where: { ...SUCCESS, createdAt: { gte: window60, lt: window30 } },
      _sum: { amount: true },
    });
    const deposits30d = await this.prisma.transaction.aggregate({
      where: { ...SUCCESS, type: 'DEPOSIT', createdAt: { gte: window30 } },
      _sum: { amount: true },
    });
    const depositsPrev30d = await this.prisma.transaction.aggregate({
      where: { ...SUCCESS, type: 'DEPOSIT', createdAt: { gte: window60, lt: window30 } },
      _sum: { amount: true },
    });
    const pendingReviews = await this.prisma.transaction.count({
      where: { status: 'PENDING', approvalStatus: 'PENDING' },
    });

    return {
      totals: {
        users,
        activeUsers,
        pendingUsers,
        suspendedUsers,
        newUsers30d,
        newUsersPrev30d,
        transactions30d,
        volume: money(volumeAll._sum.amount ?? 0),
        volume30d: money(volume30d._sum.amount ?? 0),
        volumePrev30d: money(volumePrev30d._sum.amount ?? 0),
        deposits30d: money(deposits30d._sum.amount ?? 0),
        depositsPrev30d: money(depositsPrev30d._sum.amount ?? 0),
        pendingReviews,
      },
      revenue: await this.monthlySeries(now),
      weekly: await this.weeklySeries(now),
    };
  }

  /** Last 12 complete months of `SUCCESS` volume, bucketed by year-month. */
  private async monthlySeries(now: number): Promise<AdminRevenuePoint[]> {
    const monthKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;
    const buckets = new Map<
      string,
      { month: string; revenue: number; expenses: number; volume: number }
    >();
    const today = new Date(now);
    for (let i = 11; i >= 0; i--) {
      const month = new Date(today.getFullYear(), today.getMonth() - i, 1);
      buckets.set(monthKey(month), {
        month: month.toLocaleString('en-US', { month: 'short' }),
        revenue: 0,
        expenses: 0,
        volume: 0,
      });
    }

    const rows = await this.prisma.transaction.findMany({
      where: {
        status: 'SUCCESS',
        createdAt: { gte: new Date(today.getFullYear(), today.getMonth() - 11, 1) },
      },
      select: { type: true, amount: true, createdAt: true },
    });

    for (const row of rows) {
      const bucket = buckets.get(monthKey(row.createdAt));
      if (!bucket) continue;
      const amount = Number(row.amount);
      bucket.volume += amount;
      if (row.type === 'DEPOSIT') bucket.revenue += amount;
      else if (row.type === 'WITHDRAWAL') bucket.expenses += amount;
    }

    return [...buckets.values()].map((bucket) => ({
      month: bucket.month,
      revenue: money(bucket.revenue),
      expenses: money(bucket.expenses),
      volume: money(bucket.volume),
    }));
  }

  /** `SUCCESS` transaction count per day over the trailing 7 calendar days. */
  private async weeklySeries(now: number): Promise<AdminWeeklyPoint[]> {
    const dateKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const counts = new Map<string, number>();
    for (let i = 6; i >= 0; i--) {
      const day = new Date(now - i * DAY_MS);
      counts.set(dateKey(day), 0);
    }

    const rows = await this.prisma.transaction.findMany({
      where: { status: 'SUCCESS', createdAt: { gte: new Date(now - 6 * DAY_MS) } },
      select: { createdAt: true },
    });

    for (const row of rows) {
      const key = dateKey(row.createdAt);
      if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return [...counts.entries()].map(([key, transactions]) => {
      const [year, month, day] = key.split('-').map(Number);
      return { day: WEEKDAY[new Date(year, month, day).getDay()], transactions };
    });
  }
}
