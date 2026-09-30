import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { OtpChannel, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { OtpService } from '../../otp/otp.service.js';
import { OTP_SENDER, OtpSendError, type OtpSender } from '../../otp/otp-sender.interface.js';
import { AuditLogService } from '../../audit/audit-log.service.js';
import { AuthTokensService } from './auth-tokens.service.js';
import { AuthSessionsService, type SessionRequestContext } from './auth-sessions.service.js';
import { MfaChallengeService, MFA_CHALLENGE_TTL_SECONDS } from './mfa-challenge.service.js';
import { UserProvisioningService } from './user-provisioning.service.js';
import { TwoFactorService } from './two-factor.service.js';
import {
  AuthProviderError,
  SUPABASE_AUTH_BODY,
  type SupabaseAuthGateway,
  type SupabaseSession,
} from '../supabase/supabase-auth.client.js';
import type { AuthPrincipal } from '../principal/auth-principal.js';
import type {
  ChangePasswordDto,
  DisableTwoFactorDto,
  EnableTwoFactorDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  StartTwoFactorDto,
  VerifyEmailDto,
  VerifyLoginMfaDto,
  VerifyResetOtpDto,
} from '../auth.dto.js';
import { MAIL_SENDER, type MailMessage, type MailSender } from '../../../common/mail/mail.types.js';
import { welcomeEmail } from '../../../common/mail/templates/welcome.js';
import { passwordResetEmail } from '../../../common/mail/templates/password-reset.js';
import { passwordChangedEmail } from '../../../common/mail/templates/password-changed.js';

/**
 * BFF auth endpoints. Registration + password changes drive Supabase Auth via
 * the Admin API (service role); login/refresh talk to GoTrue's public token
 * endpoint. Email verification uses a 4-digit OTP issued through the shared
 * `OtpService` and confirmed via a single-use `registrationToken`. Phone
 * verification is not part of registration — it happens later through the
 * authenticated `/api/otp/*` self-service flow.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SUPABASE_AUTH_BODY) private readonly provider: SupabaseAuthGateway,
    private readonly otp: OtpService,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
    private readonly tokens: AuthTokensService,
    private readonly sessions: AuthSessionsService,
    private readonly challenges: MfaChallengeService,
    private readonly twoFactor: TwoFactorService,
    private readonly provisioning: UserProvisioningService,
    private readonly audit: AuditLogService,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  async register(dto: RegisterDto) {
    const email = this.normalizeEmail(dto.email);

    let user;
    try {
      user = await this.provider.signUp({ email, password: dto.password, fullName: dto.fullName });
    } catch (error) {
      return this.mapProviderError(error, {
        USER_EXISTS: () => {
          throw new ConflictException('An account with this email already exists');
        },
        VALIDATION: () => {
          throw new BadRequestException(
            'We could not create your account; please review your details',
          );
        },
        CONFIG: () => {
          throw new ServiceUnavailableException('Identity provider misconfigured');
        },
      });
    }

    try {
      await this.prisma.profile.create({
        data: {
          id: user!.id,
          fullName: dto.fullName.trim(),
          email,
          emailVerified: false,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('An account with this email already exists');
      }
      throw error;
    }

    await this.dispatchEmailCode(user!.id, email);
    const registrationToken = await this.tokens.signRegistrationToken(user!.id);

    await this.audit.record({
      userId: user!.id,
      action: 'auth.register',
      entityType: 'auth',
      entityId: user!.id,
      metadata: { email },
    });

    return { status: 'pending' as const, registrationToken };
  }

  async verifyEmail(dto: VerifyEmailDto) {
    const userId = await this.tokens.verifyRegistrationToken(dto.token);
    const profile = await this.prisma.profile.findUnique({ where: { id: userId } });
    if (!profile) throw new UnauthorizedException('Registration not found');

    const ok = await this.otp.consumeCode(userId, OtpChannel.EMAIL, dto.code);
    if (!ok) throw new BadRequestException('Invalid verification code');

    await this.provider.confirmEmail(userId).catch(() => {
      throw new ServiceUnavailableException('Identity provider unavailable');
    });
    const provisioned = await this.provisioning.provision(userId);
    await this.tokens.consumeRegistrationToken(dto.token);

    await this.audit.record({
      userId,
      action: 'auth.email_verified',
      entityType: 'auth',
      entityId: userId,
    });
    if (provisioned) {
      await this.audit.record({
        userId,
        action: 'account.create',
        entityType: 'account',
        entityId: provisioned.accountId,
      });
      await this.audit.record({
        userId,
        action: 'wallet.create',
        entityType: 'wallet',
        entityId: provisioned.walletId,
      });
      const email = welcomeEmail({
        firstName: profile.fullName,
        accountNumber: provisioned.accountNumber,
      });
      await this.sendBestEffort(
        { to: profile.email, subject: email.subject, html: email.html },
        'mail.welcome',
        userId,
      );
    }
    return { verified: true as const };
  }

  async resendVerificationOtp(email: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { email: this.normalizeEmail(email) },
      select: { id: true, email: true, emailVerified: true },
    });
    if (!profile || profile.emailVerified) return { status: 'sent' as const };

    await this.dispatchEmailCode(profile.id, profile.email);
    const registrationToken = await this.tokens.signRegistrationToken(profile.id);
    return { status: 'sent' as const, registrationToken };
  }

  async login(dto: LoginDto, context: SessionRequestContext = {}) {
    const email = this.normalizeEmail(dto.email);

    let session: SupabaseSession;
    try {
      session = await this.provider.signInWithPassword(email, dto.password);
    } catch (error) {
      if (error instanceof AuthProviderError) {
        // This path answers a real, actionable message ("verify your email")
        // instead of the blanket 503, so it never reaches `mapProviderError`
        // and would otherwise log nothing. A wrong-password bug looks exactly
        // like a bad password here, which is not a distinction worth guessing
        // at from the outside.
        this.logger.warn(`Identity login rejected (${error.code}): ${error.message}`);
        switch (error.code) {
          case 'INVALID_CREDENTIALS':
            throw new UnauthorizedException('Invalid email or password');
          case 'EMAIL_NOT_CONFIRMED':
            throw new ForbiddenException('Please verify your email before logging in');
          default:
            throw new ServiceUnavailableException('Identity provider unavailable');
        }
      }
      throw error;
    }

    // With a second factor on, the provider session is parked server-side and
    // no token is released until `POST /api/auth/login/mfa` accepts the code.
    if (await this.twoFactor.isEnabled(session.user.id)) {
      const challengeId = await this.challenges.create({
        userId: session.user.id,
        session,
      });
      await this.audit.record({
        userId: session.user.id,
        action: 'auth.login.mfa_challenge',
        entityType: 'auth',
        entityId: session.user.id,
        metadata: { challengeId },
      });
      return {
        mfaRequired: true as const,
        challengeId,
        expiresIn: MFA_CHALLENGE_TTL_SECONDS,
      };
    }

    await this.sessions.record(session, context);
    await this.audit.record({
      userId: session.user.id,
      action: 'auth.login',
      entityType: 'auth',
      entityId: session.user.id,
    });

    return this.toSession(session);
  }

  /** Completes a login parked by {@link login} once the second factor checks out. */
  async verifyLoginMfa(dto: VerifyLoginMfaDto, context: SessionRequestContext = {}) {
    const parked = await this.challenges.consume(dto.challengeId);
    const method = await this.twoFactor.verify(parked.userId, dto.code);

    await this.sessions.record(parked.session, context);
    await this.audit.record({
      userId: parked.userId,
      action: 'auth.login',
      entityType: 'auth',
      entityId: parked.userId,
      metadata: { mfa: method },
    });
    return this.toSession(parked.session);
  }

  async twoFactorStatus(principal: AuthPrincipal) {
    return this.twoFactor.status(principal.userId);
  }

  /** Re-checks the caller's password before touching the second factor. */
  async startTwoFactorSetup(principal: AuthPrincipal, dto: StartTwoFactorDto) {
    await this.verifyOwnPassword(principal, dto.password);

    const setup = await this.twoFactor.startSetup(
      principal.userId,
      this.normalizeEmail(principal.email ?? ''),
    );
    await this.audit.record({
      userId: principal.userId,
      action: 'auth.2fa_setup_started',
      entityType: 'auth',
      entityId: principal.userId,
    });
    return setup;
  }

  async enableTwoFactor(principal: AuthPrincipal, dto: EnableTwoFactorDto) {
    const result = await this.twoFactor.enable(principal.userId, dto.code);
    await this.audit.record({
      userId: principal.userId,
      action: 'auth.2fa_enabled',
      entityType: 'auth',
      entityId: principal.userId,
    });
    return result;
  }

  /**
   * Turns the second factor off. Both the password and a current code are
   * required so a stolen access token alone cannot downgrade the account.
   */
  async disableTwoFactor(principal: AuthPrincipal, dto: DisableTwoFactorDto) {
    await this.verifyOwnPassword(principal, dto.password);
    await this.twoFactor.verify(principal.userId, dto.code);
    await this.twoFactor.disable(principal.userId);
    await this.audit.record({
      userId: principal.userId,
      action: 'auth.2fa_disabled',
      entityType: 'auth',
      entityId: principal.userId,
    });
    return { status: 'disabled' as const };
  }

  async refresh(refreshToken: string, context: SessionRequestContext = {}) {
    let session: SupabaseSession;
    try {
      session = await this.provider.refresh(refreshToken);
    } catch (error) {
      if (error instanceof AuthProviderError) {
        // Same reasoning as `login`: this branch answers a specific message, so
        // it never reaches `mapProviderError` and would log nothing.
        this.logger.warn(`Identity refresh rejected (${error.code}): ${error.message}`);
        // GoTrue answers an unknown or malformed refresh token with
        // `validation_failed` ("Refresh token is not valid"), not
        // `invalid_grant`. Treating that as anything but a bad credential fell
        // through to the 503 below, so a client with a revoked or expired token
        // was told the provider was down instead of being asked to log in
        // again.
        if (error.code === 'INVALID_CREDENTIALS' || error.code === 'VALIDATION') {
          throw new UnauthorizedException('Invalid refresh token');
        }
        throw new ServiceUnavailableException('Identity provider unavailable');
      }
      throw error;
    }

    // A revoked device keeps its access token until it expires, but must never
    // be able to mint another one.
    if (await this.sessions.isRevoked(session.sessionId)) {
      throw new UnauthorizedException('This session has been revoked');
    }
    await this.sessions.record(session, context);
    return this.toSession(session);
  }

  /**
   * Re-verifies the caller's own password. GoTrue exposes no password-check
   * endpoint, so this performs a throw-away password grant and throws the
   * tokens away; it also proves the grant resolved to *this* principal.
   */
  private async verifyOwnPassword(principal: AuthPrincipal, password: string): Promise<void> {
    if (!principal.email) {
      throw new BadRequestException('Your account has no email to verify against');
    }

    let verified: SupabaseSession;
    try {
      verified = await this.provider.signInWithPassword(
        this.normalizeEmail(principal.email),
        password,
      );
    } catch (error) {
      if (error instanceof AuthProviderError) {
        if (error.code === 'INVALID_CREDENTIALS') {
          throw new UnauthorizedException('Current password is incorrect');
        }
        throw new ServiceUnavailableException('Identity provider unavailable');
      }
      throw error;
    }
    if (verified.user.id !== principal.userId) {
      throw new UnauthorizedException('Current password is incorrect');
    }
  }

  /**
   * Change the caller's own password: the current one is re-verified against the
   * identity provider (GoTrue has no password-check endpoint, so this performs
   * a throw-away password grant and discards the tokens it returns), then every
   * *other* session is revoked so a stolen device loses access immediately.
   */
  async changePassword(principal: AuthPrincipal, dto: ChangePasswordDto) {
    await this.verifyOwnPassword(principal, dto.currentPassword);

    try {
      await this.provider.setPassword(principal.userId, dto.newPassword);
    } catch (error) {
      if (error instanceof AuthProviderError) {
        if (error.code === 'NOT_FOUND') throw new UnauthorizedException('Account not found');
        if (error.code === 'VALIDATION') {
          throw new BadRequestException('Please choose a stronger password');
        }
        throw new ServiceUnavailableException('Identity provider unavailable');
      }
      throw error;
    }

    const revoked = await this.sessions.revokeAll(principal, 'password_changed', {
      exceptSessionId: principal.sessionId,
    });
    await this.audit.record({
      userId: principal.userId,
      action: 'auth.change_password',
      entityType: 'auth',
      entityId: principal.userId,
      metadata: { revokedSessions: revoked },
    });

    if (principal.email) {
      const profile = await this.prisma.profile.findUnique({
        where: { id: principal.userId },
        select: { email: true, fullName: true },
      });
      if (profile) {
        const email = passwordChangedEmail({
          firstName: profile.fullName,
          revokedSessions: revoked,
        });
        await this.sendBestEffort(
          { to: profile.email, subject: email.subject, html: email.html },
          'mail.password_changed',
          principal.userId,
        );
      }
    }

    return { status: 'success' as const, revokedSessions: revoked };
  }

  /** Revoke the session making the request. Idempotent and never fails. */
  async logout(principal: AuthPrincipal) {
    if (principal.sessionId) {
      await this.prisma.authSession.updateMany({
        where: { userId: principal.userId, sessionId: principal.sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'logout' },
      });
    }
    await this.audit.record({
      userId: principal.userId,
      action: 'auth.logout',
      entityType: 'auth',
      entityId: principal.userId,
    });
    return { status: 'signed_out' as const };
  }

  async forgotPassword(email: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { email: this.normalizeEmail(email) },
      select: { id: true, email: true },
    });
    // Always report "sent" — no account enumeration via this endpoint.
    if (!profile) return { status: 'sent' as const };

    await this.dispatchEmailCode(profile.id, profile.email);
    return { status: 'sent' as const };
  }

  async verifyResetOtp(dto: VerifyResetOtpDto) {
    const profile = await this.prisma.profile.findUnique({
      where: { email: this.normalizeEmail(dto.email) },
      select: { id: true },
    });
    if (!profile) throw new BadRequestException('Invalid verification code');

    const ok = await this.otp.consumeCode(profile.id, OtpChannel.EMAIL, dto.code);
    if (!ok) throw new BadRequestException('Invalid verification code');

    const resetToken = await this.tokens.signResetToken(profile.id);
    return { resetToken };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const userId = await this.tokens.verifyResetToken(dto.token);

    try {
      await this.provider.setPassword(userId, dto.newPassword);
    } catch (error) {
      if (error instanceof AuthProviderError) {
        if (error.code === 'NOT_FOUND') {
          throw new UnauthorizedException('Account not found');
        }
        throw new ServiceUnavailableException('Identity provider unavailable');
      }
      throw error;
    }

    await this.audit.record({
      userId,
      action: 'auth.reset_password',
      entityType: 'auth',
      entityId: userId,
    });
    await this.tokens.consumeResetToken(dto.token);
    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: { email: true, fullName: true },
    });
    if (profile) {
      const email = passwordResetEmail({ firstName: profile.fullName });
      await this.sendBestEffort(
        { to: profile.email, subject: email.subject, html: email.html },
        'mail.password_reset',
        userId,
      );
    }
    return { status: 'success' as const };
  }

  /**
   * Registration completes at email verification: mark the profile verified and
   * provision the user's single account + wallet (1:1) in the same transaction,
   * then supply that account number going forward. Idempotent — a re-run (or an
   * in-flight duplicate) resolves to an already-provisioned state.
   */
  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Best-effort transactional email (welcome, card registered, password-reset
   * confirmation): a delivery failure is audited but never fails the request.
   * Credential emails (OTP codes) do NOT go through here — those fail closed.
   */
  private async sendBestEffort(
    message: MailMessage,
    action: string,
    userId: string,
  ): Promise<void> {
    try {
      await this.mail.send(message);
    } catch {
      await this.audit
        .record({ userId, action, entityType: 'mail', entityId: userId })
        .catch(() => undefined);
    }
  }

  /** Normalize an email to lowercase for storage + lookups. */
  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Issue a fresh 4-digit email OTP and deliver it, failing closed (503 + code
   * voided) when the sender is down.
   */
  private async dispatchEmailCode(userId: string, email: string): Promise<string> {
    const code = await this.otp.generateCode(userId, OtpChannel.EMAIL);
    try {
      await this.sender.send({ channel: OtpChannel.EMAIL, target: email, code });
    } catch (error) {
      if (error instanceof OtpSendError) {
        await this.otp.invalidate(userId, OtpChannel.EMAIL);
        throw new ServiceUnavailableException('Unable to send verification code');
      }
      throw error;
    }
    return code;
  }

  private toSession(session: SupabaseSession) {
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
      user: {
        id: session.user.id,
        email: session.user.email,
        phone: session.user.phone,
      },
    };
  }

  /**
   * Map identity-provider failures to HTTP semantics. `handlers` overrides the
   * default `PROVIDER → 503` mapping per code.
   */
  private mapProviderError(
    error: unknown,
    handlers: Partial<Record<NonNullable<AuthProviderError['code']>, () => never>>,
  ): never {
    if (!(error instanceof AuthProviderError)) throw error;
    // The client only ever sees "Identity provider unavailable", so without this
    // the log cannot distinguish bad service-role credentials from GoTrue being
    // unreachable or 5xx-ing, and the two have completely different fixes.
    this.logger.warn(`Identity provider call failed (${error.code}): ${error.message}`);
    const handler = handlers[error.code];
    if (handler) handler();
    throw new ServiceUnavailableException('Identity provider unavailable');
  }
}
