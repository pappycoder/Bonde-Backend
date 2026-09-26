import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { AuditLogService } from '../../audit/audit-log.service.js';
import type { AuthPrincipal } from '../principal/auth-principal.js';
import type { AuthSessionDto } from '../auth.dto.js';
import type { SupabaseSession } from '../supabase/supabase-auth.client.js';

/** Where a session was seen from, captured on the login/refresh request. */
export interface SessionRequestContext {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

const USER_AGENT_MAX = 512;
const IP_ADDRESS_MAX = 64;
/** Cap on the device list a user can revoke from; the UI never pages beyond it. */
const MAX_SESSIONS = 20;

/**
 * Device sessions mirrored from Supabase.
 *
 * Supabase is the source of truth for authentication, so this table is a
 * *record* of the sessions it issued: rows appear on login/refresh and are
 * listed so a user can review and revoke the devices signed in to their
 * account. Revoking marks the row and — because `AuthService.refresh` refuses
 * to rotate a revoked `session_id` — blocks that session from ever obtaining
 * another token. Access tokens already issued stay valid until they expire.
 */
@Injectable()
export class AuthSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Mirror a newly issued session (login) or touch an existing one (refresh).
   * Silently no-ops when the provider payload carries no `session_id`.
   */
  async record(session: SupabaseSession, context: SessionRequestContext = {}): Promise<void> {
    if (!session.sessionId) return;

    const tokenExpiresAt = new Date(Date.now() + session.expiresIn * 1000);
    const existing = await this.prisma.authSession.findUnique({
      where: { sessionId: session.sessionId },
      select: { id: true, userId: true, revokedAt: true },
    });

    if (existing) {
      // A revoked row stays revoked: refresh must never resurrect it.
      if (existing.revokedAt) return;
      await this.prisma.authSession.update({
        where: { id: existing.id },
        data: { lastUsedAt: new Date(), expiresAt: tokenExpiresAt },
      });
      return;
    }

    await this.prisma.authSession.create({
      data: {
        id: randomUUID(),
        userId: session.user.id,
        sessionId: session.sessionId,
        userAgent: this.clip(context.userAgent, USER_AGENT_MAX),
        ipAddress: this.clip(context.ipAddress, IP_ADDRESS_MAX),
        expiresAt: tokenExpiresAt,
      },
    });
  }

  /** True when the provider session has been revoked by the user or a policy. */
  async isRevoked(sessionId: string | null): Promise<boolean> {
    if (!sessionId) return false;
    const row = await this.prisma.authSession.findUnique({
      where: { sessionId },
      select: { revokedAt: true },
    });
    return Boolean(row?.revokedAt);
  }

  /** The caller's active sessions, most recently used first. */
  async list(principal: AuthPrincipal): Promise<AuthSessionDto[]> {
    const rows = await this.prisma.authSession.findMany({
      where: { userId: principal.userId, revokedAt: null },
      orderBy: { lastUsedAt: 'desc' },
      take: MAX_SESSIONS,
    });
    return rows.map((row) => ({
      id: row.id,
      userAgent: row.userAgent,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt.toISOString(),
      tokenExpiresAt: row.expiresAt.toISOString(),
      current: row.sessionId === principal.sessionId,
    }));
  }

  /**
   * Revoke one of the caller's own sessions (owned-404: never 403, so session
   * ids are not probeable). Idempotent — revoking twice is not an error.
   */
  async revoke(principal: AuthPrincipal, id: string): Promise<{ id: string; revoked: true }> {
    const row = await this.prisma.authSession.findFirst({
      where: { id, userId: principal.userId },
      select: { id: true, sessionId: true, revokedAt: true },
    });
    if (!row) throw new NotFoundException('Session not found');

    if (!row.revokedAt) {
      await this.prisma.authSession.update({
        where: { id: row.id },
        data: { revokedAt: new Date(), revokeReason: 'user' },
      });
      await this.audit.record({
        userId: principal.userId,
        action: 'auth.session.revoke',
        entityType: 'auth-session',
        entityId: row.id,
        metadata: { sessionId: row.sessionId, reason: 'user' },
      });
    }
    return { id: row.id, revoked: true };
  }

  /**
   * Revoke every active session of the caller, optionally sparing the one making
   * the request. Used after a password change and on logout.
   */
  async revokeAll(
    principal: AuthPrincipal,
    reason: string,
    options: { exceptSessionId?: string | null } = {},
  ): Promise<number> {
    const except = options.exceptSessionId;
    const { count } = await this.prisma.authSession.updateMany({
      where: {
        userId: principal.userId,
        revokedAt: null,
        ...(except ? { sessionId: { not: except } } : {}),
      },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    if (count > 0) {
      await this.audit.record({
        userId: principal.userId,
        action: 'auth.session.revoke',
        entityType: 'auth',
        entityId: principal.userId,
        metadata: { reason, revoked: count },
      });
    }
    return count;
  }

  private clip(value: string | undefined, max: number): string | null {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
  }
}
