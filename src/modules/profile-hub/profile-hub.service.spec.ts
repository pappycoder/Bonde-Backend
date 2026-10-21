import { describe, expect, it, vi } from 'vitest';
import { ProfileHubService } from './profile-hub.service.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PreferencesDto, SupportRequestDto } from './preferences.dto.js';

function setup() {
  const db = {
    $queryRaw: vi.fn(async () => []),
    profile: {
      findUnique: vi.fn(async () => ({
        preferences: { hideBalances: true },
        cardPlan: 'FREE',
        cardPlanExpiresAt: null,
      })),
      update: vi.fn(async () => undefined),
    },
    wallet: { count: vi.fn(async () => 0) },
    card: { count: vi.fn(async () => 0) },
    transaction: { count: vi.fn(async () => 0) },
    transactionApproval: { count: vi.fn(async () => 0) },
    billingOrder: { count: vi.fn(async () => 0) },
    supportTicket: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'ticket', status: 'OPEN' })),
    },
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(db),
  };
  const passcode = { validate: vi.fn(async () => undefined) };
  return { db, passcode, service: new ProfileHubService(db as never, passcode as never) };
}
describe('Profile hub', () => {
  it('merges account preferences without dropping earlier choices', async () => {
    const f = setup();
    expect(await f.service.updatePreferences('owner', { productNews: true })).toMatchObject({
      hideBalances: true,
      productNews: true,
      autoLockSeconds: 60,
    });
    expect(f.db.profile.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'owner' } }),
    );
  });
  it('requires valid PIN before a deletion request and never deletes data', async () => {
    const f = setup();
    f.passcode.validate.mockRejectedValueOnce(new Error('locked'));
    await expect(f.service.deletionRequest('owner', '0000')).rejects.toThrow('locked');
    expect(f.db.supportTicket.create).not.toHaveBeenCalled();
    expect(await f.service.deletionRequest('owner', '1234')).toEqual({
      id: 'ticket',
      status: 'OPEN',
      requested: true,
    });
  });
  it.each(['wallet', 'card', 'transaction', 'transactionApproval', 'billingOrder'] as const)(
    'blocks deletion for outstanding %s records',
    async (entity) => {
      const f = setup();
      f.db[entity].count.mockResolvedValueOnce(1);
      await expect(f.service.deletionRequest('owner', '1234')).rejects.toThrow();
      expect(f.db.supportTicket.create).not.toHaveBeenCalled();
    },
  );
  it('allows review requests after renewal is cancelled without deleting paid benefits', async () => {
    const f = setup();
    f.db.profile.findUnique.mockResolvedValueOnce({
      preferences: {},
      cardPlan: 'PREMIUM',
      cardPlanExpiresAt: new Date('2099-01-01'),
      billingCancelAtPeriodEnd: true,
    } as never);
    expect(await f.service.deletionRequest('owner', '1234')).toMatchObject({
      requested: true,
      status: 'OPEN',
    });
    expect(f.db.profile.update).not.toHaveBeenCalled();
  });
  it('does not expose another owner’s support ticket', async () => {
    const f = setup();
    await expect(f.service.ticket('owner', 'foreign')).rejects.toThrow('not found');
    expect(f.db.supportTicket.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'owner', id: 'foreign' } }),
    );
  });
  it('rejects blank support messages and unsafe preferences', async () => {
    const errors = await validate(
      plainToInstance(SupportRequestDto, { subject: '   ', message: '     ' }),
    );
    expect(errors).toHaveLength(2);
    expect(
      await validate(
        plainToInstance(PreferencesDto, {
          theme: 'unknown',
          autoLockSeconds: -1,
          hideBalances: 'yes',
        }),
      ),
    ).toHaveLength(3);
  });
});
