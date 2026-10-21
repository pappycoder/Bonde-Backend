import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  SUPABASE_AUTH_BODY,
  type SupabaseAuthGateway,
} from '../auth/supabase/supabase-auth.client.js';
import { PasscodeService } from '../passcode/passcode.service.js';

@Injectable()
export class EmailChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passcode: PasscodeService,
    @Inject(SUPABASE_AUTH_BODY) private readonly auth: SupabaseAuthGateway,
  ) {}
  async request(userId: string, token: string, email: string, code: string) {
    await this.passcode.validate(userId, code);
    const normalized = email.trim().toLowerCase();
    const existing = await this.prisma.profile.findUnique({
      where: { email: normalized },
      select: { id: true },
    });
    if (existing && existing.id !== userId)
      throw new ConflictException('This email cannot be used.');
    if (!this.auth.requestEmailChange)
      throw new ServiceUnavailableException('Email changes are temporarily unavailable.');
    try {
      await this.auth.requestEmailChange(token, normalized);
    } catch {
      throw new ServiceUnavailableException(
        'Unable to request this email change. Your current email has not been changed.',
      );
    }
    return { confirmationRequired: true };
  }
  async sync(userId: string) {
    if (!this.auth.getUser)
      throw new ServiceUnavailableException('Email verification is temporarily unavailable.');
    const user = await this.auth.getUser(userId);
    if (user.id !== userId || !user.emailConfirmed)
      throw new ConflictException('Confirm your new email first.');
    try {
      const profile = await this.prisma.profile.update({
        where: { id: userId },
        data: { email: user.email.toLowerCase(), emailVerified: true },
        select: { email: true },
      });
      return profile;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException('This email cannot be used. Contact support.');
      throw error;
    }
  }
}
