import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ProfilesService } from './profiles.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

const PROFILE = {
  id: USER_ID,
  fullName: 'Amina Sule',
  phone: '+2348000000000',
  phoneVerified: false,
  emailVerified: true,
  avatarUrl: null,
  onboardingCompletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function makeService(
  delegates: { [K in 'findUnique' | 'findFirst' | 'update']?: ReturnType<typeof vi.fn> } = {},
) {
  const prisma = { profile: delegates };
  const storage = {
    getPublicUrl: vi.fn(() => ({ publicUrl: 'https://cdn/bonde-avatars/x.jpeg' })),
  };
  const service = new ProfilesService(prisma as never, storage as never);
  return { service, prisma, storage };
}

describe('ProfilesService.get', () => {
  it('returns the profile for the current user', async () => {
    const { service } = makeService({ findUnique: vi.fn(async () => PROFILE) });
    await expect(service.get(USER_ID)).resolves.toMatchObject({ id: USER_ID });
  });

  it('404s when the profile has not been provisioned', async () => {
    const { service } = makeService({ findUnique: vi.fn(async () => null) });
    await expect(service.get(USER_ID)).rejects.toThrow(NotFoundException);
  });
});

describe('ProfilesService.update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a phone already used by another profile (409)', async () => {
    const { service } = makeService({
      findUnique: vi.fn(async () => PROFILE),
      findFirst: vi.fn(async () => ({ id: '99999999-9999-4999-8999-999999999999' })),
    });
    await expect(service.update(USER_ID, { phone: '+2348000000000' })).rejects.toThrow(
      ConflictException,
    );
  });

  it('updates fullName', async () => {
    const update = vi.fn(async (args) => ({ ...PROFILE, ...args.data }));
    const { service } = makeService({ findUnique: vi.fn(async () => PROFILE), update });
    const result = (await service.update(USER_ID, { fullName: 'Zainab' })) as {
      fullName: string;
    };
    expect(result.fullName).toBe('Zainab');
    expect(update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { fullName: 'Zainab' },
    });
  });

  it('resets phoneVerified when the phone changes', async () => {
    const { service } = makeService({
      findUnique: vi
        .fn()
        .mockResolvedValueOnce(PROFILE)
        .mockResolvedValueOnce({ phone: PROFILE.phone }),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async (args) => ({ ...PROFILE, ...args.data })),
    });
    const result = await service.update(USER_ID, { phone: '+2348011111111' });
    expect(result).toHaveProperty('phoneVerified', false);
  });

  it('does not touch phoneVerified when the phone is unchanged', async () => {
    const { service } = makeService({
      findUnique: vi.fn(async () => ({ ...PROFILE, phoneVerified: true })),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async (args) => ({ ...PROFILE, ...args.data, phoneVerified: true })),
    });
    const result = await service.update(USER_ID, { phone: '+2348000000000' });
    expect(result).toHaveProperty('phone', '+2348000000000');
    expect(result).toHaveProperty('phoneVerified', true);
  });

  it('stamps onboardingCompletedAt when onboarding is completed', async () => {
    const { service } = makeService({
      findUnique: vi.fn(async () => PROFILE),
      update: vi.fn(async (args) => ({ ...PROFILE, ...args.data })),
    });
    const result = await service.update(USER_ID, { onboardingCompleted: true });
    expect(result.onboardingCompletedAt).toBeInstanceOf(Date);
  });
});

describe('ProfilesService.updateAvatar', () => {
  it('only accepts paths under the user-owned prefix', async () => {
    const { service } = makeService({ findUnique: vi.fn(async () => PROFILE) });
    await expect(service.updateAvatar(USER_ID, { path: `u-other/avatar.jpeg` })).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.updateAvatar(USER_ID, { path: 'nope/avatar.jpeg' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('derives a public URL and persists it', async () => {
    const update = vi.fn(async (args) => ({ ...PROFILE, ...args.data }));
    const { service, storage } = makeService({ findUnique: vi.fn(async () => PROFILE), update });
    const result = await service.updateAvatar(USER_ID, { path: `u-${USER_ID}/avatar.jpeg` });
    expect(storage.getPublicUrl).toHaveBeenCalledWith('bonde-avatars', `u-${USER_ID}/avatar.jpeg`);
    expect(result).toHaveProperty('avatarUrl', 'https://cdn/bonde-avatars/x.jpeg');
  });
});
