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
import { AuditLogService } from '../../audit/audit-log.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'amina@bonde.app';
const PASSWORD = 'hunter2.secure';

function makeService(
  overrides: {
    provider?: Partial<SupabaseAuthGateway>;
    senderFail?: () => never;
    tokens?: Partial<AuthTokensService>;
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
        }): Promise<{ id: string; email: string; emailVerified?: boolean } | null> => null,
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
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };

  const audit = {
    record: vi.fn(async () => undefined),
  } as unknown as AuditLogService;

  const service = new AuthService(
    prisma as never,
    provider as never,
    otp as never,
    sender as never,
    tokens as never,
    audit as never,
  );

  return { service, provider, sender, otp, tokens, prisma, audit, sent, users };
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
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({ id: USER_ID, email: EMAIL });
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

  it('does not re-provision when the account already exists', async () => {
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
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({ id: USER_ID, email: EMAIL });
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
