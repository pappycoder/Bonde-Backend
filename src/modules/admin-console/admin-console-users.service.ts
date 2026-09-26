import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { money } from '../../common/money/money.js';
import { parsePaging, toPageResult } from '../../common/paging/paging.js';
import {
  buildFilterWhere,
  parseFilterEntries,
  type FilterFieldSpec,
} from '../../common/paging/filter.js';
import { qWhere } from '../../common/paging/search.js';
import { AuditLogService } from '../audit/audit-log.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { toAdminTxSummary } from './admin-tx-view.js';

export type AdminUserStatus = 'active' | 'pending' | 'suspended';

const USER_FILTER_FIELDS: Record<string, FilterFieldSpec> = {
  emailVerified: { kind: 'boolean' },
  phoneVerified: { kind: 'boolean' },
};

const USER_SEARCH_FIELDS = ['fullName', 'email', 'phone'] as const;

const USER_INCLUDE = {
  accounts: { include: { wallets: true } },
  _count: { select: { transactions: true } },
} as const satisfies Prisma.ProfileInclude;

type UserRow = Prisma.ProfileGetPayload<{ include: typeof USER_INCLUDE }>;

const RECENT_TX_LIMIT = 8;
const MAX_NAMES = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminUsersListOptions {
  page?: number;
  pageSize?: number;
  q?: string;
  filter?: string | string[];
  status?: AdminUserStatus;
}

export interface AdminUserView {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  onboardingCompleted: boolean;
  status: AdminUserStatus;
  balance: string;
  currency: string;
  accountNumber: string | null;
  accountType: string | null;
  isActive: boolean;
  joinedAt: string;
  lastActiveAt: string;
  transactionCount: number;
}

/**
 * Admin surface over profiles + their 1:1 account/wallet. The derived `status`
 * maps the provisioning state (`emailVerified`, `onboardingCompletedAt`,
 * account/wallet `isActive`) into the dashboard's active/pending/suspended
 * vocabulary. Phase 3 adds the suspend/restore transitions, which toggle
 * `isActive` on the 1:1 account + wallet and are recorded as audit-only
 * actions (admins act, but end users are never notified by a system action).
 */
@Injectable()
export class AdminConsoleUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async list(options: AdminUsersListOptions = {}) {
    const { page, pageSize, skip, take } = parsePaging(options.page, options.pageSize);
    const where = this.buildWhere(options);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.profile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: USER_INCLUDE,
      }),
      this.prisma.profile.count({ where }),
    ]);

    return toPageResult(
      items.map((item) => this.toView(item)),
      total,
      page,
      pageSize,
    );
  }

  async get(userId: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      include: USER_INCLUDE,
    });
    if (!profile) throw new NotFoundException('User not found');

    const recentTransactions = await this.prisma.transaction.findMany({
      where: { userId: profile.id },
      orderBy: { createdAt: 'desc' },
      take: RECENT_TX_LIMIT,
      include: {
        card: { select: { cardNumberLast4: true } },
        wallet: { select: { currency: true } },
      },
    });

    return {
      ...this.toView(profile),
      recentTransactions: recentTransactions.map((tx) => toAdminTxSummary(tx, tx.wallet?.currency)),
    };
  }

  /** Resolve `id → fullName` for a bounded, CSV-delimited set of user ids. */
  async names(idsRaw?: string): Promise<Record<string, string>> {
    const ids = (idsRaw ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) return {};
    if (ids.length > MAX_NAMES) {
      throw new BadRequestException(`Can resolve at most ${MAX_NAMES} user ids at once`);
    }
    for (const id of ids) {
      if (!UUID_RE.test(id)) throw new BadRequestException(`Invalid user id "${id}"`);
    }

    const profiles = await this.prisma.profile.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true },
    });
    const byId: Record<string, string> = {};
    for (const profile of profiles) byId[profile.id] = profile.fullName;
    return byId;
  }

  /**
   * Deactivate the user's 1:1 account + wallet. Idempotent: suspending an
   * already-suspended user returns the current state without writing. The
   * transition (not the no-op) is recorded via `admin.users.suspend`.
   */
  async suspend(userId: string, actorUserId: string, reason?: string) {
    const { account, wallet, changed } = await this.toggleActive(userId, false);
    if (changed) {
      const ops: Prisma.PrismaPromise<unknown>[] = [
        this.prisma.account.update({
          where: { id: account!.id },
          data: { isActive: false },
        }),
      ];
      if (wallet) {
        ops.push(
          this.prisma.wallet.update({
            where: { id: wallet.id },
            data: { isActive: false },
          }),
        );
      }
      await this.prisma.$transaction(ops);
      await this.audit.record({
        userId: actorUserId,
        action: 'admin.users.suspend',
        entityType: 'user',
        entityId: userId,
        metadata: reason ? { reason } : undefined,
      });
    }
    return this.get(userId);
  }

  /** Reactivate the user's 1:1 account + wallet (idempotent, audited). */
  async restore(userId: string, actorUserId: string) {
    const { account, wallet, changed } = await this.toggleActive(userId, true);
    if (changed) {
      const ops: Prisma.PrismaPromise<unknown>[] = [
        this.prisma.account.update({
          where: { id: account!.id },
          data: { isActive: true },
        }),
      ];
      if (wallet) {
        ops.push(
          this.prisma.wallet.update({
            where: { id: wallet.id },
            data: { isActive: true },
          }),
        );
      }
      await this.prisma.$transaction(ops);
      await this.audit.record({
        userId: actorUserId,
        action: 'admin.users.restore',
        entityType: 'user',
        entityId: userId,
      });
    }
    return this.get(userId);
  }

  /** Loads the user's account/wallet and reports whether a state flip is needed. */
  private async toggleActive(
    userId: string,
    active: boolean,
  ): Promise<{
    account: NonNullable<UserRow['accounts'][number]> | null;
    wallet: UserRow['accounts'][number]['wallets'][number] | null;
    changed: boolean;
  }> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      include: USER_INCLUDE,
    });
    if (!profile) throw new NotFoundException('User not found');
    const account = profile.accounts[0];
    if (!account) {
      throw new ConflictException('User has no provisioned account to manage');
    }
    const wallet = account.wallets[0];
    const already = active
      ? account.isActive && (!wallet || wallet.isActive)
      : !account.isActive || (wallet !== undefined && !wallet.isActive);
    return { account, wallet: wallet ?? null, changed: !already };
  }

  private buildWhere(options: AdminUsersListOptions): Prisma.ProfileWhereInput {
    const clauses: Prisma.ProfileWhereInput[] = [];
    const filters = buildFilterWhere(parseFilterEntries(options.filter), USER_FILTER_FIELDS);
    if (Object.keys(filters).length > 0) clauses.push(filters);
    const search = qWhere(options.q, USER_SEARCH_FIELDS);
    if (search) clauses.push(search);
    const status = statusWhere(options.status);
    if (Object.keys(status).length > 0) clauses.push(status);

    if (clauses.length === 0) return {};
    if (clauses.length === 1) return clauses[0];
    return { AND: clauses };
  }

  private toView(profile: UserRow): AdminUserView {
    const account = profile.accounts[0];
    const wallet = account?.wallets[0];
    return {
      id: profile.id,
      fullName: profile.fullName,
      email: profile.email,
      phone: profile.phone,
      avatarUrl: profile.avatarUrl,
      emailVerified: profile.emailVerified,
      phoneVerified: profile.phoneVerified,
      onboardingCompleted: profile.onboardingCompletedAt !== null,
      status: this.deriveStatus(profile),
      balance: wallet ? money(wallet.balance) : '0.00',
      currency: wallet?.currency ?? 'NGN',
      accountNumber: account?.accountNumber ?? null,
      accountType: account?.accountType ?? null,
      isActive: account?.isActive ?? false,
      joinedAt: profile.createdAt.toISOString(),
      lastActiveAt: profile.updatedAt.toISOString(),
      transactionCount: profile._count.transactions,
    };
  }

  /** Must mirror `statusWhere` so the status filter and the rendered status agree. */
  private deriveStatus(profile: UserRow): AdminUserStatus {
    const account = profile.accounts[0];
    const wallet = account?.wallets[0];
    if (account && !account.isActive) return 'suspended';
    if (wallet && !wallet.isActive) return 'suspended';
    if (!account || !profile.emailVerified || !profile.onboardingCompletedAt) return 'pending';
    return 'active';
  }
}

function statusWhere(status?: AdminUserStatus): Prisma.ProfileWhereInput {
  switch (status) {
    case 'active':
      return {
        emailVerified: true,
        onboardingCompletedAt: { not: null },
        accounts: { some: { isActive: true, wallets: { every: { isActive: true } } } },
      };
    case 'suspended':
      return {
        OR: [
          { accounts: { some: { isActive: false } } },
          {
            accounts: {
              some: { isActive: true, wallets: { some: { isActive: false } } },
            },
          },
        ],
      };
    case 'pending':
      return {
        OR: [{ emailVerified: false }, { onboardingCompletedAt: null }, { accounts: { none: {} } }],
      };
    default:
      return {};
  }
}
