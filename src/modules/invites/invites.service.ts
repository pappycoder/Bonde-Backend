import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit-log.service.js';
import { UserProvisioningService } from '../auth/services/user-provisioning.service.js';
import {
  AuthProviderError,
  SUPABASE_AUTH_BODY,
  type SupabaseAuthGateway,
} from '../auth/supabase/supabase-auth.client.js';
import { MAIL_SENDER, type MailSender } from '../../common/mail/mail.types.js';
import { inviteEmail } from '../../common/mail/templates/invite.js';
import type { AcceptInviteDto, CreateInviteDto, ListInvitesQuery } from './invites.dto.js';
import type { AppConfig } from '../../config/configuration.js';
import type { BondeRole } from '../auth/principal/auth-principal.js';

/** Links stay valid for a week; an unaccepted invite is dead weight after that. */
const INVITE_TTL_DAYS = 7;
const TOKEN_BYTES = 32;

export type InviteRole = BondeRole;

export interface InviteView {
  id: string;
  email: string;
  fullName: string | null;
  role: InviteRole;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  invitedBy: string | null;
  inviterName: string | null;
  createdAt: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
}

export interface AcceptedInviteView {
  email: string;
  fullName: string | null;
  role: InviteRole;
  expiresAt: string;
  valid: boolean;
}

@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SUPABASE_AUTH_BODY) private readonly provider: SupabaseAuthGateway,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
    private readonly audit: AuditLogService,
    private readonly provisioning: UserProvisioningService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Issues a single-use invite: stores a hashed token and emails the raw link.
   * The token is never returned to the caller, so a lost email can only be
   * replaced by a fresh invite.
   */
  async create(dto: CreateInviteDto, invitedBy: string) {
    const email = this.normalizeEmail(dto.email);
    const role: InviteRole = dto.role ?? 'USER';

    const existingProfile = await this.prisma.profile.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingProfile) throw new ConflictException('That email already has an account');

    // One live invite per email: re-issuing replaces (and voids) the old token.
    const live = await this.prisma.userInvite.findFirst({
      where: { email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (live) {
      await this.prisma.userInvite.update({
        where: { id: live.id },
        data: { revokedAt: new Date() },
      });
    }

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
    const invite = await this.prisma.userInvite.create({
      data: {
        id: randomUUID(),
        email,
        fullName: dto.fullName?.trim() || null,
        role,
        tokenHash: this.hashToken(token),
        expiresAt,
        invitedBy,
      },
    });

    const mail = inviteEmail({
      firstName: invite.fullName ?? email.split('@')[0] ?? '',
      inviteUrl: this.inviteUrl(token),
      role,
      expiresInDays: INVITE_TTL_DAYS,
    });
    try {
      await this.mail.send({ to: email, subject: mail.subject, html: mail.html });
    } catch {
      // Fail closed: the token exists nowhere else, so void the invite.
      await this.prisma.userInvite.delete({ where: { id: invite.id } }).catch(() => undefined);
      throw new ServiceUnavailableException('Unable to send the invitation email');
    }

    await this.audit.record({
      userId: invitedBy,
      action: 'admin.invite.create',
      entityType: 'user_invite',
      entityId: invite.id,
      metadata: { email, role },
    });
    await this.audit
      .record({
        userId: invitedBy,
        action: 'mail.invite',
        entityType: 'mail',
        entityId: invite.id,
        metadata: { email },
      })
      .catch(() => undefined);

    return this.toView({ ...invite, inviter: null });
  }

  async list(query: ListInvitesQuery) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const where: Prisma.UserInviteWhereInput = query.status
      ? {
          ...this.statusFilter(query.status),
          email: { contains: query.q ?? '', mode: 'insensitive' },
        }
      : { email: { contains: query.q ?? '', mode: 'insensitive' } };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.userInvite.findMany({
        where,
        include: { inviter: { select: { fullName: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.userInvite.count({ where }),
    ]);

    return {
      items: items.map((invite) => this.toView(invite)),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async revoke(id: string, actorId: string) {
    const invite = await this.prisma.userInvite.findUnique({ where: { id } });
    if (!invite) throw new BadRequestException('Invite not found');
    if (invite.acceptedAt) throw new BadRequestException('Invite was already accepted');

    await this.prisma.userInvite.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.audit.record({
      userId: actorId,
      action: 'admin.invite.revoke',
      entityType: 'user_invite',
      entityId: id,
      metadata: { email: invite.email },
    });
    return { id, revoked: true as const };
  }

  /** Read-only view of an invite for the public accept page. */
  async peek(token: string): Promise<AcceptedInviteView> {
    const invite = await this.findUsable(token);
    if (!invite) {
      // Answer uniformly: never confirm whether a token ever existed.
      return { email: '', fullName: null, role: 'USER', expiresAt: '', valid: false };
    }
    return {
      email: invite.email,
      fullName: invite.fullName,
      role: invite.role as InviteRole,
      expiresAt: invite.expiresAt.toISOString(),
      valid: true,
    };
  }

  /**
   * Redeems an invite: creates the Supabase user (pre-confirmed — the emailed
   * link is the email proof), provisions the profile + account + wallet, and
   * marks the invite used. The token is single-use even if a later step fails,
   * so a partially redeemed invite can be re-issued by an admin.
   */
  async accept(dto: AcceptInviteDto) {
    const invite = await this.findUsable(dto.token);
    if (!invite) throw new BadRequestException('This invitation is no longer valid');

    // Claim the token atomically BEFORE creating the identity: a lost race must
    // not leave an orphaned auth user behind. The claim is released again if
    // the provider rejects the attempt, so a typo'd password is retryable.
    const claimed = await this.prisma.userInvite.updateMany({
      where: { id: invite.id, acceptedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (claimed.count === 0) throw new BadRequestException('This invitation is no longer valid');

    const fullName = (dto.fullName ?? invite.fullName ?? '').trim();
    let user;
    try {
      user = await this.provider.signUp({
        email: invite.email,
        password: dto.password,
        fullName: fullName || invite.email.split('@')[0] || 'Bonde user',
        role: invite.role as InviteRole,
        // The emailed single-use link is the email proof, so the invitee skips
        // the OTP/verification dance and can sign in straight after accepting.
        emailConfirm: true,
      });
    } catch (error) {
      await this.releaseClaim(invite.id);
      if (error instanceof AuthProviderError) {
        if (error.code === 'USER_EXISTS') {
          throw new ConflictException('That email already has an account');
        }
        if (error.code === 'VALIDATION') {
          throw new BadRequestException('Please choose a stronger password');
        }
        throw new ServiceUnavailableException('Identity provider unavailable');
      }
      throw error;
    }

    try {
      await this.prisma.profile.create({
        data: {
          id: user!.id,
          fullName: fullName || user!.email,
          email: invite.email,
          emailVerified: true,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('That email already has an account');
      }
      throw error;
    }

    const provisioned = await this.provisioning.provision(user!.id);

    await this.audit.record({
      userId: user!.id,
      action: 'auth.invite_accepted',
      entityType: 'user_invite',
      entityId: invite.id,
      metadata: { email: invite.email, role: invite.role, invitedBy: invite.invitedBy },
    });
    if (provisioned) {
      await this.audit.record({
        userId: user!.id,
        action: 'account.create',
        entityType: 'account',
        entityId: provisioned.accountId,
      });
      await this.audit.record({
        userId: user!.id,
        action: 'wallet.create',
        entityType: 'wallet',
        entityId: provisioned.walletId,
      });
    }

    return { status: 'accepted' as const, email: invite.email };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Best-effort un-claim so a failed acceptance can be retried. */
  private async releaseClaim(inviteId: string): Promise<void> {
    await this.prisma.userInvite
      .updateMany({ where: { id: inviteId }, data: { acceptedAt: null } })
      .catch(() => undefined);
  }

  private async findUsable(token: string) {
    if (!token) return null;
    return this.prisma.userInvite.findFirst({
      where: {
        tokenHash: this.hashToken(token),
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
  }

  private statusFilter(status: 'pending' | 'accepted' | 'revoked' | 'expired') {
    const now = new Date();
    if (status === 'accepted') return { acceptedAt: { not: null } };
    if (status === 'revoked') return { revokedAt: { not: null }, acceptedAt: null };
    if (status === 'expired') {
      return { acceptedAt: null, revokedAt: null, expiresAt: { lte: now } };
    }
    return { acceptedAt: null, revokedAt: null, expiresAt: { gt: now } };
  }

  private toView(invite: {
    id: string;
    email: string;
    fullName: string | null;
    role: string;
    expiresAt: Date;
    acceptedAt: Date | null;
    revokedAt: Date | null;
    invitedBy: string | null;
    createdAt: Date;
    inviter: { fullName: string } | null;
  }): InviteView {
    const now = Date.now();
    const status: InviteView['status'] = invite.acceptedAt
      ? 'accepted'
      : invite.revokedAt
        ? 'revoked'
        : invite.expiresAt.getTime() <= now
          ? 'expired'
          : 'pending';
    return {
      id: invite.id,
      email: invite.email,
      fullName: invite.fullName,
      role: invite.role as InviteRole,
      expiresAt: invite.expiresAt.toISOString(),
      acceptedAt: invite.acceptedAt ? invite.acceptedAt.toISOString() : null,
      revokedAt: invite.revokedAt ? invite.revokedAt.toISOString() : null,
      invitedBy: invite.invitedBy,
      inviterName: invite.inviter?.fullName ?? null,
      createdAt: invite.createdAt.toISOString(),
      status,
    };
  }

  private inviteUrl(token: string): string {
    const base = this.config.get('adminAppUrl', { infer: true }).replace(/\/+$/, '');
    return `${base}/accept-invite?token=${encodeURIComponent(token)}`;
  }
}
