import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { OtpChannel, AccountType, Prisma } from '@prisma/client';
import { AuthService } from './auth.service.js';
import { AuthProviderError, type SupabaseAuthGateway } from '../supabase/supabase-auth.client.js';
import { OtpSendError, type OtpSendRequest } from '../../otp/otp-sender.interface.js';
import { OtpService } from '../../otp/otp.service.js';
import { AuthTokensService } from './auth-tokens.service.js';
import { AuthSessionsService } from './auth-sessions.service.js';
import { MfaChallengeService } from './mfa-challenge.service.js';
import { TwoFactorService } from './two-factor.service.js';
import { UserProvisioningService } from './user-provisioning.service.js';
import type { AuthPrincipal } from '../principal/auth-principal.js';
import { AuditLogService } from '../../audit/audit-log.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'amina@bonde.app';
const PASSWORD = 'hunter2.secure';

function makeService(
  overrides: {
    provider?: Partial<SupabaseAuthGateway>;
    senderFail?: () => never;
    tokens?: Partial<AuthTokensService>;
    twoFactorEnabled?: boolean;
    parkedLogin?: { userId: string; session: unknown } | null;
  } = {},
) {
  const users = new Map<string, { password: string; confirmed: boolean }>();

  const provider: SupabaseAuthGateway = {
    signUp: vi.fn(async ({ email, password }) => {
      if (users.has(email)) throw new AuthProviderError('USER_EXISTS', 'exists');
      users.set(email, { password, confirmed: false });
      return { id: USER_ID, email, phone: null, emailConfirmed: false };
    }),
    signInWithPassword: vi.fn(async (email, password) => {
      const account = users.get(email);
      if (!account || account.password !== password) {
        throw new AuthProviderError('INVALID_CREDENTIALS', 'bad credentials');
      }
      if (!account.confirmed) {
        throw new AuthProviderError('EMAIL_NOT_CONFIRMED', 'unconfirmed');
      }
      return {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 3600,
        sessionId: 'session-1',
        user: { id: USER_ID, email, phone: null, emailConfirmed: true },
      };
    }),
    refresh: vi.fn(async (refreshToken) => {
      if (refreshToken !== 'valid-refresh') {
        throw new AuthProviderError('INVALID_CREDENTIALS', 'bad refresh');
      }
      return {
        accessToken: 'access-token-2',
        refreshToken: 'refresh-token-2',
        expiresIn: 3600,
        sessionId: 'session-1',
        user: { id: USER_ID, email: EMAIL, phone: null, emailConfirmed: true },
      };
    }),
    confirmEmail: vi.fn(async (userId) => {
      if (userId !== USER_ID) throw new AuthProviderError('NOT_FOUND', 'missing');
      const account = users.get(EMAIL);
      if (account) account.confirmed = true;
    }),
    setPassword: vi.fn(async (userId, password) => {
      if (userId !== USER_ID) throw new AuthProviderError('NOT_FOUND', 'missing');
      users.set(EMAIL, { password, confirmed: true });
    }),
    updateUserMetadata: vi.fn(async () => undefined),
  };
  Object.assign(provider, overrides.provider);

  const sent: OtpSendRequest[] = [];
  const sender = {
    send: vi.fn(async (request: OtpSendRequest) => {
      if (overrides.senderFail) overrides.senderFail();
      sent.push(request);
    }),
  };

  const otp = {
    generateCode: vi.fn(async () => '1234'),
    consumeCode: vi.fn(async () => true),
    invalidate: vi.fn(async () => undefined),
  } as unknown as OtpService;

  const tokens = {
    signRegistrationToken: vi.fn(async (userId: string) => `reg.${userId}.tok`),
    signResetToken: vi.fn(async (userId: string) => `reset.${userId}.tok`),
    verifyRegistrationToken: vi.fn(async () => USER_ID),
    verifyResetToken: vi.fn(async () => USER_ID),
    consumeRegistrationToken: vi.fn(async () => USER_ID),
    consumeResetToken: vi.fn(async () => USER_ID),
    ...overrides.tokens,
  } as unknown as AuthTokensService;

  const prisma = {
    profile: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        id: args.data.id,
        fullName: args.data.fullName,
        email: args.data.email,
        emailVerified: args.data.emailVerified,
      })),
      findUnique: vi.fn(
        async (_args: {
          where: { id: string };
        }): Promise<{
          id: string;
          email: string;
          fullName?: string;
          emailVerified?: boolean;
        } | null> => null,
      ),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: args.where.id,
        ...args.data,
      })),
    },
    account: {
      findUnique: vi.fn(async (): Promise<{ id: string; userId: string } | null> => null),
      create: vi.fn(async (args: { data: Record<string, string> }) => ({
        id: args.data.id,
        userId: args.data.userId,
        accountNumber: args.data.accountNumber,
        accountType: args.data.accountType,
      })),
    },
    wallet: {
      create: vi.fn(async (args: { data: Record<string, string> }) => ({
        id: args.data.id,
        accountId: args.data.accountId,
      })),
    },
    authSession: {
      findUnique: vi.fn(async (): Promise<unknown> => null),
      findFirst: vi.fn(async (): Promise<unknown> => null),
      findMany: vi.fn(async (): Promise<unknown[]> => []),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };

  const audit = {
    record: vi.fn(async () => undefined),
  } as unknown as AuditLogService;

  const mail = {
    send: vi.fn(async () => undefined),
  };

  const sessions = {
    record: vi.fn(async () => undefined),
    isRevoked: vi.fn(async () => false),
    list: vi.fn(async () => []),
    revoke: vi.fn(async (_user: unknown, id: string) => ({ id, revoked: true as const })),
    revokeAll: vi.fn(async () => 3),
  } as unknown as AuthSessionsService;

  const parked = overrides.parkedLogin;

  const challenges = {
    create: vi.fn(async () => 'challenge-1'),
    consume: vi.fn(async () => {
      if (!parked) throw new UnauthorizedException('Sign-in expired. Please start again.');
      return parked as never;
    }),
  } as unknown as MfaChallengeService;

  const twoFactor = {
    isEnabled: vi.fn(async () => overrides.twoFactorEnabled === true),
    status: vi.fn(async () => ({
      enabled: overrides.twoFactorEnabled === true,
      enrolledAt: null,
      recoveryCodesRemaining: 0,
    })),
    startSetup: vi.fn(async () => ({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/Bonde:amina@bonde.app?secret=JBSWY3DPEHPK3PXP',
    })),
    enable: vi.fn(async () => ({ recoveryCodes: ['K3M4P-R7T2X'] })),
    verify: vi.fn(async () => 'totp' as const),
    disable: vi.fn(async () => undefined),
  } as unknown as TwoFactorService;

  // The real provisioning transaction runs against the in-memory prisma mock.
  const provisioning = new UserProvisioningService(prisma as never);

  const service = new AuthService(
    prisma as never,
    provider as never,
    otp as never,
    sender as never,
    tokens as never,
    sessions as never,
    challenges as never,
    twoFactor as never,
    provisioning,
    audit as never,
    mail as never,
  );

  return {
    service,
    provider,
    sender,
    otp,
    tokens,
    sessions,
    prisma,
    audit,
    mail,
    sent,
    users,
    challenges,
    twoFactor,
  };
}

describe('AuthService.register', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates the Supabase user + profile and dispatches a 4-digit email OTP', async () => {
    const { service, sender, prisma, audit } = makeService();

    const result = await service.register({
      fullName: 'Amina Sule',
      email: ' AmInA@Bonde.APP ',
      password: PASSWORD,
    });

    expect(result.status).toBe('pending');
    expect(result.registrationToken).toBe(`reg.${USER_ID}.tok`);

    expect(prisma.profile.create).toHaveBeenCalledWith({
      data: { id: USER_ID, fullName: 'Amina Sule', email: EMAIL, emailVerified: false },
    });
    expect(sender.send).toHaveBeenCalledWith({
      channel: OtpChannel.EMAIL,
      target: EMAIL,
      code: expect.stringMatching(/^[0-9]{4}$/),
      purpose: 'verify-email',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.register', userId: USER_ID }),
    );
  });

  it('maps an existing Supabase user to 409', async () => {
    const { service, provider } = makeService();
    vi.mocked(provider.signUp).mockRejectedValueOnce(new AuthProviderError('USER_EXISTS', 'dup'));

    await expect(
      service.register({ fullName: 'Amina', email: EMAIL, password: PASSWORD }),
    ).rejects.toThrow(ConflictException);
  });

  it('maps a provider outage to 503', async () => {
    const { service, provider } = makeService();
    vi.mocked(provider.signUp).mockRejectedValueOnce(new AuthProviderError('PROVIDER', 'down'));

    await expect(
      service.register({ fullName: 'Amina', email: EMAIL, password: PASSWORD }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('maps GoTrue payload rejection (validation) to 400', async () => {
    const { service, provider } = makeService();
    vi.mocked(provider.signUp).mockRejectedValueOnce(
      new AuthProviderError('VALIDATION', 'GoTrue 400: Password should be at least 6 characters.'),
    );

    await expect(
      service.register({ fullName: 'Amina', email: EMAIL, password: PASSWORD }),
    ).rejects.toThrow(BadRequestException);
  });

  it('maps a misconfigured identity provider (401 service role) to a clear 503', async () => {
    const { service, provider } = makeService();
    vi.mocked(provider.signUp).mockRejectedValueOnce(
      new AuthProviderError('CONFIG', 'GoTrue 401: invalid_jwt'),
    );

    await expect(
      service.register({ fullName: 'Amina', email: EMAIL, password: PASSWORD }),
    ).rejects.toThrowError('Identity provider misconfigured');
  });

  it('maps a duplicate local profile to 409', async () => {
    const { service, prisma } = makeService();
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
      meta: {},
    });
    vi.mocked(prisma.profile.create).mockRejectedValueOnce(p2002);

    await expect(
      service.register({ fullName: 'Amina', email: EMAIL, password: PASSWORD }),
    ).rejects.toThrow(ConflictException);
  });

  it('fails closed with 503 and voids the code when delivery fails', async () => {
    const { service, otp } = makeService({
      senderFail: () => {
        throw new OtpSendError('down');
      },
    });

    await expect(
      service.register({ fullName: 'Amina', email: EMAIL, password: PASSWORD }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(otp.invalidate).toHaveBeenCalledWith(USER_ID, OtpChannel.EMAIL);
  });
});

describe('AuthService.verifyEmail', () => {
  beforeEach(() => vi.clearAllMocks());

  function seedProfile(prisma: ReturnType<typeof makeService>['prisma']) {
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({
      id: USER_ID,
      email: EMAIL,
      fullName: 'Amina Sule',
    });
  }

  it('confirms the email and flags the profile verified', async () => {
    const { service, prisma, audit } = makeService();
    seedProfile(prisma);

    await expect(service.verifyEmail({ token: 'tok', code: '1234' })).resolves.toEqual({
      verified: true,
    });
    expect(prisma.profile.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { emailVerified: true },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.email_verified' }),
    );
  });

  it('provisions the account + wallet atomically on verification', async () => {
    const { service, prisma, audit } = makeService();
    seedProfile(prisma);

    await expect(service.verifyEmail({ token: 'tok', code: '1234' })).resolves.toEqual({
      verified: true,
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.account.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER_ID,
          accountType: AccountType.CHECKING,
          accountNumber: expect.stringMatching(/^\d{10}$/),
        }),
      }),
    );
    const accountData = prisma.account.create.mock.calls[0][0].data;
    expect(prisma.wallet.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accountId: accountData.id }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'account.create', userId: USER_ID }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'wallet.create', userId: USER_ID }),
    );
  });

  it('sends a best-effort welcome email with the account number after provisioning', async () => {
    const { service, mail, prisma } = makeService();
    seedProfile(prisma);

    await expect(service.verifyEmail({ token: 'tok', code: '1234' })).resolves.toEqual({
      verified: true,
    });
    expect(mail.send).toHaveBeenCalledTimes(1);
    const doc = mail.send.mock.calls[0][0] as { to: string; subject: string; html: string };
    expect(doc.to).toBe(EMAIL);
    expect(doc.subject).toContain('Welcome');
    const accountNumber = prisma.account.create.mock.calls[0][0].data.accountNumber;
    expect(doc.html).toContain('Amina Sule');
    expect(doc.html).toContain(accountNumber);
  });

  it('keeps verification successful when the welcome email delivery fails', async () => {
    const { service, mail, prisma, audit } = makeService();
    seedProfile(prisma);
    vi.mocked(mail.send).mockRejectedValueOnce(new Error('mail down'));

    await expect(service.verifyEmail({ token: 'tok', code: '1234' })).resolves.toEqual({
      verified: true,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mail.welcome', userId: USER_ID }),
    );
  });

  it('does not send a welcome email on a re-run (no re-provision)', async () => {
    const { service, prisma, audit } = makeService();
    seedProfile(prisma);
    vi.mocked(prisma.account.findUnique).mockResolvedValueOnce({ id: 'acc', userId: USER_ID });

    await expect(service.verifyEmail({ token: 'tok', code: '1234' })).resolves.toEqual({
      verified: true,
    });
    expect(prisma.account.create).not.toHaveBeenCalled();
    expect(prisma.wallet.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'account.create' }),
    );
  });

  it('rejects a bad code without confirming', async () => {
    const { service, otp, prisma } = makeService();
    seedProfile(prisma);
    vi.mocked(otp.consumeCode).mockResolvedValueOnce(false);

    await expect(service.verifyEmail({ token: 'tok', code: '0000' })).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.profile.update).not.toHaveBeenCalled();
  });

  it('rejects a token whose user has no profile', async () => {
    const { service } = makeService();

    await expect(service.verifyEmail({ token: 'tok', code: '1234' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('fails with 503 and does NOT confirm when the provider is down', async () => {
    const { service, provider, prisma } = makeService();
    seedProfile(prisma);
    vi.mocked(provider.confirmEmail).mockRejectedValueOnce(
      new AuthProviderError('PROVIDER', 'down'),
    );

    await expect(service.verifyEmail({ token: 'tok', code: '1234' })).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(prisma.profile.update).not.toHaveBeenCalled();
  });
});

describe('AuthService.login / refresh', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a session and audits login', async () => {
    const { service, prisma, audit } = makeService();
    await service.register({ fullName: 'Amina', email: EMAIL, password: PASSWORD });
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({
      id: USER_ID,
      email: EMAIL,
      fullName: 'Amina Sule',
    });
    await service.verifyEmail({ token: 'tok', code: '1234' });

    const session = await service.login({ email: EMAIL, password: PASSWORD });
    expect(session).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      user: { id: USER_ID, email: EMAIL, phone: null },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login', userId: USER_ID }),
    );
  });

  it('401 on bad credentials', async () => {
    const { service } = makeService();
    await expect(service.login({ email: EMAIL, password: 'wrong' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('403 when the email is not yet confirmed', async () => {
    const { service, provider } = makeService();
    vi.mocked(provider.signInWithPassword).mockRejectedValueOnce(
      new AuthProviderError('EMAIL_NOT_CONFIRMED', 'unconfirmed'),
    );
    await expect(service.login({ email: EMAIL, password: PASSWORD })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refreshes a session', async () => {
    const { service } = makeService();
    const session = await service.refresh('valid-refresh');
    expect(session.accessToken).toBe('access-token-2');
  });

  it('401 on a bad refresh token', async () => {
    const { service } = makeService();
    await expect(service.refresh('nope')).rejects.toThrow(UnauthorizedException);
  });

  it('mirrors the issued session with the requesting device', async () => {
    const { service, sessions } = makeService();
    await service.refresh('valid-refresh', { userAgent: 'iPhone', ipAddress: '10.0.0.9' });
    expect(sessions.record).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      { userAgent: 'iPhone', ipAddress: '10.0.0.9' },
    );
  });

  it('refuses to rotate a revoked session', async () => {
    const { service, sessions } = makeService();
    vi.mocked(sessions.isRevoked).mockResolvedValueOnce(true);

    await expect(service.refresh('valid-refresh')).rejects.toThrow(
      new UnauthorizedException('This session has been revoked'),
    );
    expect(sessions.record).not.toHaveBeenCalled();
  });
});

describe('AuthService.changePassword', () => {
  beforeEach(() => vi.clearAllMocks());

  const principal: AuthPrincipal = {
    userId: USER_ID,
    email: EMAIL,
    phone: null,
    role: 'USER',
    sessionId: 'session-1',
    appMetadata: {},
    userMetadata: {},
  };

  async function withConfirmedUser() {
    const harness = makeService();
    await harness.service.register({ fullName: 'Amina', email: EMAIL, password: PASSWORD });
    vi.mocked(harness.prisma.profile.findUnique).mockResolvedValue({
      id: USER_ID,
      email: EMAIL,
      fullName: 'Amina Sule',
    });
    await harness.service.verifyEmail({ token: 'tok', code: '1234' });
    return harness;
  }

  it('swaps the password, revokes other sessions, audits and emails', async () => {
    const { service, provider, sessions, audit, mail } = await withConfirmedUser();
    vi.mocked(provider.signInWithPassword).mockClear();

    const result = await service.changePassword(principal, {
      currentPassword: PASSWORD,
      newPassword: 'new.hunter2.secure',
    });

    expect(result).toEqual({ status: 'success', revokedSessions: 3 });
    expect(provider.setPassword).toHaveBeenCalledWith(USER_ID, 'new.hunter2.secure');
    expect(sessions.revokeAll).toHaveBeenCalledWith(principal, 'password_changed', {
      exceptSessionId: 'session-1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.change_password',
        metadata: { revokedSessions: 3 },
      }),
    );
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: EMAIL, subject: 'Your Bonde password was changed' }),
    );
  });

  it('401s on a wrong current password and never writes', async () => {
    const { service, provider, sessions } = await withConfirmedUser();

    await expect(
      service.changePassword(principal, {
        currentPassword: 'not-the-password',
        newPassword: 'new.hunter2.secure',
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(provider.setPassword).not.toHaveBeenCalled();
    expect(sessions.revokeAll).not.toHaveBeenCalled();
  });

  it('rejects a provider-rejected password as 400', async () => {
    const { service, provider } = await withConfirmedUser();
    vi.mocked(provider.setPassword).mockRejectedValueOnce(
      new AuthProviderError('VALIDATION', 'weak password'),
    );

    await expect(
      service.changePassword(principal, { currentPassword: PASSWORD, newPassword: 'weak' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('400s when the principal carries no email', async () => {
    const { service } = await withConfirmedUser();
    await expect(
      service.changePassword(
        { ...principal, email: null },
        { currentPassword: PASSWORD, newPassword: 'new.hunter2.secure' },
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('AuthService.logout', () => {
  beforeEach(() => vi.clearAllMocks());

  it('revokes the current session row and audits', async () => {
    const { service, prisma, audit } = makeService();
    const principal: AuthPrincipal = {
      userId: USER_ID,
      email: EMAIL,
      phone: null,
      role: 'USER',
      sessionId: 'session-1',
      appMetadata: {},
      userMetadata: {},
    };

    await expect(service.logout(principal)).resolves.toEqual({ status: 'signed_out' });
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        sessionId: 'session-1',
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date), revokeReason: 'logout' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.logout', userId: USER_ID }),
    );
  });
});

describe('AuthService forgot-password', () => {
  beforeEach(() => vi.clearAllMocks());

  function seedProfile(prisma: ReturnType<typeof makeService>['prisma']) {
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({
      id: USER_ID,
      email: EMAIL,
      emailVerified: true,
    });
  }

  it('always returns sent and never reveals whether the email exists', async () => {
    const { service, sender } = makeService();
    await expect(service.forgotPassword(EMAIL)).resolves.toEqual({ status: 'sent' });
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('dispatches a code when the account exists', async () => {
    const { service, sender, prisma } = makeService();
    seedProfile(prisma);
    await expect(service.forgotPassword(' amina@bonde.app ')).resolves.toEqual({
      status: 'sent',
    });
    expect(sender.send).toHaveBeenCalledWith({
      channel: OtpChannel.EMAIL,
      target: EMAIL,
      code: expect.stringMatching(/^[0-9]{4}$/),
      // Must not be 'verify-email' — that mismatch is what this asserts.
      purpose: 'recovery',
    });
  });

  it('verifies the reset OTP and returns a one-time reset token', async () => {
    const { service, prisma } = makeService();
    seedProfile(prisma);
    await expect(service.verifyResetOtp({ email: EMAIL, code: '1234' })).resolves.toEqual({
      resetToken: `reset.${USER_ID}.tok`,
    });
  });

  it('rejects a wrong reset OTP', async () => {
    const { service, otp, prisma } = makeService();
    seedProfile(prisma);
    vi.mocked(otp.consumeCode).mockResolvedValueOnce(false);
    await expect(service.verifyResetOtp({ email: EMAIL, code: '0000' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects an unknown email for verify-reset (no enumeration)', async () => {
    const { service } = makeService();
    await expect(
      service.verifyResetOtp({ email: 'nobody@bonde.app', code: '1234' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('resets the password and audits it', async () => {
    const { service, audit } = makeService();
    await expect(
      service.resetPassword({ token: 'reset.tok', newPassword: 'new.secure.123' }),
    ).resolves.toEqual({ status: 'success' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.reset_password', userId: USER_ID }),
    );
  });

  it('emails a best-effort password-reset confirmation when the profile is readable', async () => {
    const { service, mail, prisma } = makeService();
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({
      id: USER_ID,
      email: EMAIL,
      fullName: 'Amina Sule',
    });

    await expect(
      service.resetPassword({ token: 'reset.tok', newPassword: 'new.secure.123' }),
    ).resolves.toEqual({ status: 'success' });
    expect(mail.send).toHaveBeenCalledTimes(1);
    const doc = mail.send.mock.calls[0][0] as { to: string; subject: string; html: string };
    expect(doc.to).toBe(EMAIL);
    expect(doc.subject).toContain('password was changed');
    expect(doc.html).toContain('Amina');
  });

  it('keeps the reset successful when the confirmation email fails', async () => {
    const { service, mail, prisma } = makeService();
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({
      id: USER_ID,
      email: EMAIL,
      fullName: 'Amina Sule',
    });
    vi.mocked(mail.send).mockRejectedValueOnce(new Error('mail down'));

    await expect(
      service.resetPassword({ token: 'reset.tok', newPassword: 'new.secure.123' }),
    ).resolves.toEqual({ status: 'success' });
  });

  it('401 when reset-password uses a bad/consumed token', async () => {
    const { service, tokens } = makeService({
      tokens: {
        verifyResetToken: vi.fn(async () => {
          throw new UnauthorizedException('used');
        }),
      },
    });
    void tokens;
    await expect(
      service.resetPassword({ token: 'bad', newPassword: 'new.secure.123' }),
    ).rejects.toThrow(UnauthorizedException);
  });
});

describe('AuthService resendVerificationOtp', () => {
  beforeEach(() => vi.clearAllMocks());

  function seedProfile(prisma: ReturnType<typeof makeService>['prisma'], emailVerified: boolean) {
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({
      id: USER_ID,
      email: EMAIL,
      emailVerified,
    });
  }

  it('always returns sent and reveals nothing for an unknown email', async () => {
    const { service, sender, tokens } = makeService();
    await expect(service.resendVerificationOtp(EMAIL)).resolves.toEqual({ status: 'sent' });
    expect(sender.send).not.toHaveBeenCalled();
    expect(tokens.signRegistrationToken).not.toHaveBeenCalled();
  });

  it('never issues a token for an already-verified email', async () => {
    const { service, sender, tokens, prisma } = makeService();
    seedProfile(prisma, true);
    await expect(service.resendVerificationOtp(EMAIL)).resolves.toEqual({ status: 'sent' });
    expect(sender.send).not.toHaveBeenCalled();
    expect(tokens.signRegistrationToken).not.toHaveBeenCalled();
  });

  it('dispatches a code and issues a fresh registration token when unverified', async () => {
    const { service, sender, tokens, prisma } = makeService();
    seedProfile(prisma, false);
    await expect(service.resendVerificationOtp(' amina@bonde.app ')).resolves.toEqual({
      status: 'sent',
      registrationToken: `reg.${USER_ID}.tok`,
    });
    expect(sender.send).toHaveBeenCalledWith({
      channel: OtpChannel.EMAIL,
      target: EMAIL,
      code: expect.stringMatching(/^[0-9]{4}$/),
      purpose: 'verify-email',
    });
    expect(tokens.signRegistrationToken).toHaveBeenCalledWith(USER_ID);
  });
});

describe('AuthService second factor', () => {
  beforeEach(() => vi.clearAllMocks());

  /** Registers + verifies an account so `login` gets past GoTrue. */
  async function confirmedUser(
    service: AuthService,
    prisma: ReturnType<typeof makeService>['prisma'],
  ) {
    await service.register({ fullName: 'Amina', email: EMAIL, password: PASSWORD });
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({
      id: USER_ID,
      email: EMAIL,
      fullName: 'Amina Sule',
    });
    await service.verifyEmail({ token: 'tok', code: '1234' });
  }

  it('parks the login and returns a challenge instead of tokens', async () => {
    const { service, prisma, sessions, challenges, audit } = makeService({
      twoFactorEnabled: true,
    });
    await confirmedUser(service, prisma);

    const result = await service.login({ email: EMAIL, password: PASSWORD });

    expect(result).toEqual({
      mfaRequired: true,
      challengeId: 'challenge-1',
      expiresIn: 300,
    });
    expect(challenges.create).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }));
    // Nothing is handed out before the code is presented.
    expect(sessions.record).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login.mfa_challenge', userId: USER_ID }),
    );
  });

  it('never audits a completed login before the code is verified', async () => {
    const { service, prisma, audit } = makeService({ twoFactorEnabled: true });
    await confirmedUser(service, prisma);

    await service.login({ email: EMAIL, password: PASSWORD });

    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login' }),
    );
  });

  it('releases the parked session once the code checks out', async () => {
    const session = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      sessionId: 'session-1',
      user: { id: USER_ID, email: EMAIL, phone: null, emailConfirmed: true },
    };
    const { service, sessions, audit } = makeService({
      parkedLogin: { userId: USER_ID, session },
    });

    const result = await service.verifyLoginMfa(
      { challengeId: 'challenge-1', code: '123456' },
      { userAgent: 'jest' },
    );

    expect(result).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      user: { id: USER_ID, email: EMAIL, phone: null },
    });
    expect(sessions.record).toHaveBeenCalledWith(session, { userAgent: 'jest' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login', metadata: { mfa: 'totp' } }),
    );
  });

  it('401s when the challenge is gone before the code arrives', async () => {
    const { service } = makeService();
    await expect(
      service.verifyLoginMfa({ challengeId: 'challenge-1', code: '123456' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('re-checks the password before starting enrolment', async () => {
    const { service, prisma, twoFactor } = makeService();
    await confirmedUser(service, prisma);

    const setup = await service.startTwoFactorSetup({ userId: USER_ID, email: EMAIL } as never, {
      password: PASSWORD,
    });

    expect(setup).toEqual({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/Bonde:amina@bonde.app?secret=JBSWY3DPEHPK3PXP',
    });
    expect(twoFactor.startSetup).toHaveBeenCalledWith(USER_ID, EMAIL);
  });

  it('refuses to start enrolment with the wrong password', async () => {
    const { service, prisma, twoFactor } = makeService();
    await confirmedUser(service, prisma);

    await expect(
      service.startTwoFactorSetup({ userId: USER_ID, email: EMAIL } as never, {
        password: 'wrong-password',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(twoFactor.startSetup).not.toHaveBeenCalled();
  });

  it('400s enrolment when the principal carries no email', async () => {
    const { service, twoFactor } = makeService();

    await expect(
      service.startTwoFactorSetup({ userId: USER_ID, email: null } as never, {
        password: PASSWORD,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(twoFactor.startSetup).not.toHaveBeenCalled();
  });

  it('enables the factor and audits it', async () => {
    const { service, twoFactor, audit } = makeService();

    const result = await service.enableTwoFactor({ userId: USER_ID, email: EMAIL } as never, {
      code: '123456',
    });

    expect(result).toEqual({ recoveryCodes: ['K3M4P-R7T2X'] });
    expect(twoFactor.enable).toHaveBeenCalledWith(USER_ID, '123456');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.2fa_enabled' }),
    );
  });

  it('disables only with the password AND a valid code', async () => {
    const { service, prisma, twoFactor, audit } = makeService();
    await confirmedUser(service, prisma);

    const result = await service.disableTwoFactor({ userId: USER_ID, email: EMAIL } as never, {
      password: PASSWORD,
      code: '123456',
    });

    expect(result).toEqual({ status: 'disabled' });
    expect(twoFactor.verify).toHaveBeenCalledWith(USER_ID, '123456');
    expect(twoFactor.disable).toHaveBeenCalledWith(USER_ID);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.2fa_disabled' }),
    );
  });

  it('keeps the factor on when the password is right but the code is not', async () => {
    const { service, prisma, twoFactor } = makeService();
    await confirmedUser(service, prisma);
    vi.mocked(twoFactor.verify).mockRejectedValue(
      new UnauthorizedException('Invalid authenticator code'),
    );

    await expect(
      service.disableTwoFactor({ userId: USER_ID, email: EMAIL } as never, {
        password: PASSWORD,
        code: '000000',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(twoFactor.disable).not.toHaveBeenCalled();
  });
});
