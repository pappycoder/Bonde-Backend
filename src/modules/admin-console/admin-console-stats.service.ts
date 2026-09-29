import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { money } from '../../common/money/money.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { statusWhere } from './admin-console-users.service.js';

const DAY_MS = 86_400_000;

/** Days at or below this bucket by day; longer windows bucket by month. */
const DAILY_BUCKET_LIMIT = 31;

export interface AdminSeriesPoint {
  /** Bucket label: `Sep 12` for daily buckets, `Sep` for monthly ones. */
  label: string;
  /** DEPOSITS in SUCCESS, fixed 2-decimal string. */
  revenue: string;
  /** WITHDRAWALS in SUCCESS, fixed 2-decimal string. */
  expenses: string;
  /** All SUCCESS volume, fixed 2-decimal string. */
  volume: string;
  /** All SUCCESS transaction count in the bucket. */
  transactions: number;
}

export interface AdminStatsTotals {
  users: number;
  activeUsers: number;
  pendingUsers: number;
  suspendedUsers: number;
  pendingReviews: number;
  openTickets: number;
  /** All-time SUCCESS volume, fixed 2-decimal string. */
  volume: string;
}

/** The trailing window the caller asked for, and the one before it. */
export interface AdminWindow {
  days: number;
  from: string;
  to: string;
}

export interface AdminStatsSummary {
  window: AdminWindow;
  /** State gauges — all-time by nature, never windowed. */
  totals: AdminStatsTotals;
  /** Period metrics, scoped to `window` with the prior period for deltas. */
  windowTotals: {
    newUsers: number;
    newUsersPrev: number;
    transactions: number;
    volume: string;
    volumePrev: string;
    deposits: string;
    depositsPrev: string;
  };
  /** One series over `window`, oldest first, bucketed day or month. */
  series: AdminSeriesPoint[];
}

/**
 * Dashboard/analytics KPIs for the admin console. All money is `SUCCESS`
 * volume in NGN (fixed 2-decimal strings via `money()`). The caller picks a
 * trailing window (`days`, 1-365, default 30); every period metric is scoped
 * to it and compared against the immediately preceding window of equal length,
 * so the dashboard deltas stay meaningful at any range. State gauges (user
 * counts, review queue, open tickets) are all-time on purpose — a suspended
 * user is not something that "expires".
 *
 * The series is bucketed in JS from one scoped read: daily for windows up to
 * 31 days, monthly beyond that. Cheap at dashboard scale and keeps the SQL
 * simple, matching the existing approach.
 */
@Injectable()
export class AdminConsoleStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(days = 30): Promise<AdminStatsSummary> {
    const to = new Date();
    const from = new Date(to.getTime() - days * DAY_MS);
    const prevTo = from;
    const prevFrom = new Date(from.getTime() - days * DAY_MS);

    const [users, activeUsers, pendingUsers, suspendedUsers, pendingReviews, openTickets] =
      await Promise.all([
        this.prisma.profile.count(),
        this.prisma.profile.count({ where: statusWhere('active') }),
        this.prisma.profile.count({ where: statusWhere('pending') }),
        this.prisma.profile.count({ where: statusWhere('suspended') }),
        this.prisma.transaction.count({ where: { status: 'PENDING', approvalStatus: 'PENDING' } }),
        this.prisma.supportTicket.count({ where: { status: 'OPEN' } }),
      ]);

    const SUCCESS: Prisma.TransactionWhereInput = { status: 'SUCCESS' };
    const inWindow = { gte: from, lt: to };
    const inPrevWindow = { gte: prevFrom, lt: prevTo };

    const [
      newUsers,
      newUsersPrev,
      transactions,
      volumeAll,
      volume,
      volumePrev,
      deposits,
      depositsPrev,
    ] = await Promise.all([
      this.prisma.profile.count({ where: { createdAt: inWindow } }),
      this.prisma.profile.count({ where: { createdAt: inPrevWindow } }),
      this.prisma.transaction.count({ where: { ...SUCCESS, createdAt: inWindow } }),
      this.prisma.transaction.aggregate({ where: SUCCESS, _sum: { amount: true } }),
      this.prisma.transaction.aggregate({
        where: { ...SUCCESS, createdAt: inWindow },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { ...SUCCESS, createdAt: inPrevWindow },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { ...SUCCESS, type: 'DEPOSIT', createdAt: inWindow },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { ...SUCCESS, type: 'DEPOSIT', createdAt: inPrevWindow },
        _sum: { amount: true },
      }),
    ]);

    return {
      window: { days, from: from.toISOString(), to: to.toISOString() },
      totals: {
        users,
        activeUsers,
        pendingUsers,
        suspendedUsers,
        pendingReviews,
        openTickets,
        volume: money(volumeAll._sum.amount ?? 0),
      },
      windowTotals: {
        newUsers,
        newUsersPrev,
        transactions,
        volume: money(volume._sum.amount ?? 0),
        volumePrev: money(volumePrev._sum.amount ?? 0),
        deposits: money(deposits._sum.amount ?? 0),
        depositsPrev: money(depositsPrev._sum.amount ?? 0),
      },
      series: await this.series(days, from, to),
    };
  }

  /** `SUCCESS` volume and count over the window, bucketed by day or month. */
  private async series(days: number, from: Date, to: Date): Promise<AdminSeriesPoint[]> {
    const byDay = days <= DAILY_BUCKET_LIMIT;
    const dailyKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const monthlyKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;

    const buckets = new Map<
      string,
      { label: string; revenue: number; expenses: number; volume: number; transactions: number }
    >();
    // Anchored to whole calendar days/months, and inclusive of the day `to`
    // falls in: the window's last day is partial but must still get a bucket,
    // or the money in `windowTotals` would not match the chart.
    const start = byDay
      ? new Date(from.getFullYear(), from.getMonth(), from.getDate())
      : new Date(from.getFullYear(), from.getMonth(), 1);
    for (let cursor = new Date(start); cursor <= to; cursor.setDate(cursor.getDate() + 1)) {
      const key = byDay ? dailyKey(cursor) : monthlyKey(cursor);
      if (buckets.has(key)) continue;
      buckets.set(key, {
        // A long window can straddle a year boundary, where bare month names
        // would repeat ("Sep", …, "Sep"), so monthly labels carry the year.
        label: byDay
          ? cursor.toLocaleString('en-US', { month: 'short', day: 'numeric' })
          : cursor.toLocaleString('en-US', { month: 'short', year: '2-digit' }),
        revenue: 0,
        expenses: 0,
        volume: 0,
        transactions: 0,
      });
    }

    const rows = await this.prisma.transaction.findMany({
      where: { status: 'SUCCESS', createdAt: { gte: from, lt: to } },
      select: { type: true, amount: true, createdAt: true },
    });

    for (const row of rows) {
      const bucket = buckets.get(byDay ? dailyKey(row.createdAt) : monthlyKey(row.createdAt));
      if (!bucket) continue;
      const amount = Number(row.amount);
      bucket.volume += amount;
      bucket.transactions += 1;
      if (row.type === 'DEPOSIT') bucket.revenue += amount;
      else if (row.type === 'WITHDRAWAL') bucket.expenses += amount;
    }

    return [...buckets.values()].map((bucket) => ({
      label: bucket.label,
      revenue: money(bucket.revenue),
      expenses: money(bucket.expenses),
      volume: money(bucket.volume),
      transactions: bucket.transactions,
    }));
  }
}
