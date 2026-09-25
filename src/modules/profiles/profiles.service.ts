import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StorageService } from '../../common/storage/storage.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SUPABASE_AUTH_BODY, type SupabaseAuthGateway } from '../auth/supabase/supabase-auth.client.js';
import { UpdateAvatarDto, UpdateProfileDto } from './profiles.dto.js';

/**
 * Self-service profile. Rows mirror Supabase `auth.users` 1:1 — they are
 * created by the auth/onboarding flow, never ad-hoc. This module only reads
 * and selectively updates the current user's own profile.
 */
@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(SUPABASE_AUTH_BODY) private readonly provider: SupabaseAuthGateway,
  ) {}

  async get(userId: string) {
    const profile = await this.prisma.profile.findUnique({ where: { id: userId } });
    if (!profile) throw new NotFoundException('Profile not found');
    return profile;
  }

  async update(userId: string, dto: UpdateProfileDto) {
    await this.ensureExists(userId);

    const data: Prisma.ProfileUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName;

    if (dto.phone !== undefined) {
      const normalized = dto.phone.trim();
      await this.assertPhoneAvailable(normalized, userId);
      data.phone = normalized;
      if (await this.phoneChanged(userId, normalized)) {
        data.phoneVerified = false;
      }
    }

    if (dto.onboardingCompleted === true) {
      data.onboardingCompletedAt = new Date();
    }

    const profile = await this.prisma.profile.update({ where: { id: userId }, data });

    // The profiles row is the source of truth; mirror name changes into GoTrue
    // so future tokens/sessions and the dashboard header pick the name up.
    if (dto.fullName !== undefined && data.fullName) {
      await this.syncUserMetadata(userId, { full_name: dto.fullName.trim() });
    }

    return profile;
  }

  async updateAvatar(userId: string, dto: UpdateAvatarDto) {
    await this.ensureExists(userId);
    const path = dto.path.trim();
    if (!path.startsWith(`u-${userId}/`)) {
      throw new BadRequestException('Avatar path must live under your own u-<userId>/ prefix');
    }
    const { publicUrl } = this.storage.getPublicUrl('bonde-avatars', path);
    const profile = await this.prisma.profile.update({
      where: { id: userId },
      data: { avatarUrl: publicUrl },
    });
    if (profile.avatarUrl) {
      await this.syncUserMetadata(userId, { avatar_url: profile.avatarUrl });
    }
    return profile;
  }

  private async ensureExists(userId: string): Promise<void> {
    const existing = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Profile not found');
  }

  private async assertPhoneAvailable(phone: string, userId: string): Promise<void> {
    const clash = await this.prisma.profile.findFirst({
      where: { phone, NOT: { id: userId } },
      select: { id: true },
    });
    if (clash) throw new ConflictException('Phone is already in use');
  }

  private async phoneChanged(userId: string, phone: string): Promise<boolean> {
    const current = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: { phone: true },
    });
    return current?.phone !== phone;
  }

  /**
   * Best-effort mirror into GoTrue `user_metadata`. A provider outage must
   * never fail a profile save — the profiles row is authoritative and the
   * mismatch only affects display until the next successful sync.
   */
  private async syncUserMetadata(
    userId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.provider.updateUserMetadata(userId, metadata);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not sync user metadata for ${userId}: ${detail}`);
    }
  }
}
