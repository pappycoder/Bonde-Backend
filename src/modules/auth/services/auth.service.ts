import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { OtpChannel, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { OtpService } from '../../otp/otp.service.js';
import { OTP_SENDER, OtpSendError, type OtpSender } from '../../otp/otp-sender.interface.js';
import { AuditLogService } from '../../audit/audit-log.service.js';
import { AuthTokensService } from './auth-tokens.service.js';
import {
  AuthProviderError,
  SUPABASE_AUTH_BODY,
  type SupabaseAuthGateway,
  type SupabaseSession,
} from '../supabase/supabase-auth.client.js';
import type {
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  VerifyEmailDto,
  VerifyResetOtpDto,
} from '../auth.dto.js';

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
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SUPABASE_AUTH_BODY) private readonly provider: SupabaseAuthGateway,
    private readonly otp: OtpService,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
    private readonly tokens: AuthTokensService,
    private readonly audit: AuditLogService,
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
    await this.prisma.profile.update({
      where: { id: userId },
      data: { emailVerified: true },
    });
    await this.tokens.consumeRegistrationToken(dto.token);

    await this.audit.record({
      userId,
      action: 'auth.email_verified',
      entityType: 'auth',
      entityId: userId,
    });
    return { verified: true as const };
  }

  async resendVerificationOtp(email: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { email: this.normalizeEmail(email) },
      select: { id: true, email: true, emailVerified: true },
    });
    if (!profile || profile.emailVerified) return { status: 'sent' as const };

    await this.dispatchEmailCode(profile.id, profile.email);
    return { status: 'sent' as const };
  }

  async login(dto: LoginDto) {
    const email = this.normalizeEmail(dto.email);

    let session: SupabaseSession;
    try {
      session = await this.provider.signInWithPassword(email, dto.password);
    } catch (error) {
      if (error instanceof AuthProviderError) {
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

    await this.audit.record({
      userId: session.user.id,
      action: 'auth.login',
      entityType: 'auth',
      entityId: session.user.id,
    });

    return this.toSession(session);
  }

  async refresh(refreshToken: string) {
    let session: SupabaseSession;
    try {
      session = await this.provider.refresh(refreshToken);
    } catch (error) {
      if (error instanceof AuthProviderError) {
        if (error.code === 'INVALID_CREDENTIALS') {
          throw new UnauthorizedException('Invalid refresh token');
        }
        throw new ServiceUnavailableException('Identity provider unavailable');
      }
      throw error;
    }
    return this.toSession(session);
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
    return { status: 'success' as const };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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
    const handler = handlers[error.code];
    if (handler) handler();
    throw new ServiceUnavailableException('Identity provider unavailable');
  }
}
