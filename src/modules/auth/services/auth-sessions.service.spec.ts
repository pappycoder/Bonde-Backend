import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AuthSessionsService } from './auth-sessions.service.js';
import { AuditLogService } from '../../audit/audit-log.service.js';
import type { AuthPrincipal } from '../principal/auth-principal.js';
import type { SupabaseSession } from '../supabase/supabase-auth.client.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ROW_ID = '33333333-3333-4333-8333-333333333333';

const principal: AuthPrincipal = {
  userId: USER_ID,
  email: 'amina@bonde.app',
  phone: null,
  role: 'USER',
  sessionId: 'session-current',
  appMetadata: {},
  userMetadata: {},
};

function makeService() {
  const prisma = {
    authSession: {
      findUnique: vi.fn(async (): Promise<unknown> => null),
      findFirst: vi.fn(async (): Promise<unknown> => null),
      findMany: vi.fn(async (): Promise<unknown[]> => []),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
      updateMany: vi.fn(async () => ({ count: 2 })),
    },
  };
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditLogService;
  const service = new AuthSessionsService(prisma as never, audit);
  return { service, prisma, audit };
}

function providerSession(overrides: Partial<SupabaseSession> = {}): SupabaseSession {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresIn: 3600,
    sessionId: 'session-abc',
    user: {
      id: USER_ID,
      email: 'amina@bonde.app',
      phone: null,
      emailConfirmed: true,
    },
    ...overrides,
  };
}

describe('AuthSessionsService.record', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a row for a new session, clipping the device fingerprint', async () => {
    const { service, prisma } = makeService();

    await service.record(providerSession(), {
      userAgent: 'x'.repeat(600),
      ipAddress: ' 10.0.0.1 ',
    });

    expect(prisma.authSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER_ID,
        sessionId: 'session-abc',
        userAgent: 'x'.repeat(512),
        ipAddress: '10.0.0.1',
        expiresAt: expect.any(Date),
      }),
    });
    expect(prisma.authSession.update).not.toHaveBeenCalled();
  });

  it('touches lastUsedAt/expiresAt instead of duplicating an existing session', async () => {
    const { service, prisma } = makeService();
    vi.mocked(prisma.authSession.findUnique).mockResolvedValue({
      id: SESSION_ROW_ID,
      userId: USER_ID,
      revokedAt: null,
    });

    await service.record(providerSession());

    expect(prisma.authSession.create).not.toHaveBeenCalled();
    expect(prisma.authSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ROW_ID },
      data: { lastUsedAt: expect.any(Date), expiresAt: expect.any(Date) },
    });
  });

  it('never resurrects a revoked row', async () => {
    const { service, prisma } = makeService();
    vi.mocked(prisma.authSession.findUnique).mockResolvedValue({
      id: SESSION_ROW_ID,
      userId: USER_ID,
      revokedAt: new Date(),
    });

    await service.record(providerSession());

    expect(prisma.authSession.update).not.toHaveBeenCalled();
    expect(prisma.authSession.create).not.toHaveBeenCalled();
  });

  it('no-ops when the provider payload has no session id', async () => {
    const { service, prisma } = makeService();

    await service.record(providerSession({ sessionId: null }));

    expect(prisma.authSession.findUnique).not.toHaveBeenCalled();
    expect(prisma.authSession.create).not.toHaveBeenCalled();
  });
});

describe('AuthSessionsService.isRevoked', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is true only for a revoked row', async () => {
    const { service, prisma } = makeService();
    vi.mocked(prisma.authSession.findUnique).mockResolvedValue({ revokedAt: new Date() });
    await expect(service.isRevoked('session-abc')).resolves.toBe(true);

    vi.mocked(prisma.authSession.findUnique).mockResolvedValue({ revokedAt: null });
    await expect(service.isRevoked('session-abc')).resolves.toBe(false);
  });

  it('is false when the provider sent no session id', async () => {
    const { service, prisma } = makeService();
    await expect(service.isRevoked(null)).resolves.toBe(false);
    expect(prisma.authSession.findUnique).not.toHaveBeenCalled();
  });
});

describe('AuthSessionsService.list', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the caller’s active sessions, flagging the current device', async () => {
    const { service, prisma } = makeService();
    const createdAt = new Date('2026-09-20T10:00:00.000Z');
    vi.mocked(prisma.authSession.findMany).mockResolvedValue([
      {
        id: SESSION_ROW_ID,
        sessionId: 'session-current',
        userAgent: 'Chrome',
        ipAddress: '10.0.0.1',
        createdAt,
        lastUsedAt: createdAt,
        expiresAt: createdAt,
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        sessionId: 'session-other',
        userAgent: null,
        ipAddress: null,
        createdAt,
        lastUsedAt: createdAt,
        expiresAt: createdAt,
      },
    ] as never);

    const result = await service.list(principal);

    expect(prisma.authSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID, revokedAt: null } }),
    );
    expect(result).toEqual([
      expect.objectContaining({ id: SESSION_ROW_ID, current: true, userAgent: 'Chrome' }),
      expect.objectContaining({ current: false, userAgent: null }),
    ]);
    expect(result[0]?.createdAt).toBe(createdAt.toISOString());
  });
});

describe('AuthSessionsService.revoke', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks the row revoked and audits it', async () => {
    const { service, prisma, audit } = makeService();
    vi.mocked(prisma.authSession.findFirst).mockResolvedValue({
      id: SESSION_ROW_ID,
      sessionId: 'session-other',
      revokedAt: null,
    } as never);

    await expect(service.revoke(principal, SESSION_ROW_ID)).resolves.toEqual({
      id: SESSION_ROW_ID,
      revoked: true,
    });
    expect(prisma.authSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ROW_ID },
      data: { revokedAt: expect.any(Date), revokeReason: 'user' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.session.revoke',
        entityId: SESSION_ROW_ID,
        metadata: { sessionId: 'session-other', reason: 'user' },
      }),
    );
  });

  it('is idempotent for an already revoked row', async () => {
    const { service, prisma, audit } = makeService();
    vi.mocked(prisma.authSession.findFirst).mockResolvedValue({
      id: SESSION_ROW_ID,
      sessionId: 'session-other',
      revokedAt: new Date(),
    } as never);

    await expect(service.revoke(principal, SESSION_ROW_ID)).resolves.toEqual({
      id: SESSION_ROW_ID,
      revoked: true,
    });
    expect(prisma.authSession.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('404s for a session owned by someone else', async () => {
    const { service, prisma, audit } = makeService();
    vi.mocked(prisma.authSession.findFirst).mockResolvedValue(null);

    await expect(service.revoke(principal, SESSION_ROW_ID)).rejects.toThrow(NotFoundException);
    expect(prisma.authSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: SESSION_ROW_ID, userId: USER_ID } }),
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('AuthSessionsService.revokeAll', () => {
  beforeEach(() => vi.clearAllMocks());

  it('spares the current session and audits the count', async () => {
    const { service, prisma, audit } = makeService();

    const count = await service.revokeAll(principal, 'password_changed', {
      exceptSessionId: principal.sessionId,
    });

    expect(count).toBe(2);
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        revokedAt: null,
        sessionId: { not: 'session-current' },
      },
      data: { revokedAt: expect.any(Date), revokeReason: 'password_changed' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.session.revoke',
        metadata: { reason: 'password_changed', revoked: 2 },
      }),
    );
  });

  it('skips the audit when nothing was revoked', async () => {
    const { service, prisma, audit } = makeService();
    vi.mocked(prisma.authSession.updateMany).mockResolvedValue({ count: 0 });

    await expect(service.revokeAll(principal, 'logout')).resolves.toBe(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('never touches another user’s sessions', async () => {
    const { service, prisma } = makeService();
    await service.revokeAll({ ...principal, userId: OTHER_ID }, 'logout');
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: OTHER_ID }) }),
    );
  });
});
