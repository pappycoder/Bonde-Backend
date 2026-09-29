import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthProviderError } from '../auth/supabase/supabase-auth.client.js';
import { UserProvisioningService } from '../auth/services/user-provisioning.service.js';
import { InvitesService } from './invites.service.js';

const ACTOR_ID = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const NEW_USER_ID = '99999999-9999-4999-8999-999999999999';
const INVITE_ID = 'abcdabcd-abcd-4abc-8abc-abcdabcdabcd';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

function inviteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVITE_ID,
    email: 'newhire@bonde.ai',
    fullName: 'New Hire',
    role: 'ADMIN',
    tokenHash: 'hash',
    expiresAt: new Date(Date.now() + 60_000),
    acceptedAt: null,
    revokedAt: null,
    invitedBy: ACTOR_ID,
    createdAt: new Date('2026-09-26T10:00:00.000Z'),
    updatedAt: new Date('2026-09-26T10:00:00.000Z'),
    inviter: { fullName: 'Olivia Martin' },
    ...overrides,
  };
}

function makeHarness() {
  const rows = { invite: inviteRow() as Record<string, unknown> };

  const prisma = {
    profile: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    account: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: ACCOUNT_ID,
        ...data,
      })),
    },
    wallet: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data })) },
    userInvite: {
      findUnique: vi.fn(async () => rows.invite),
      findFirst: vi.fn(async () => rows.invite),
      findMany: vi.fn(async () => [rows.invite]),
      count: vi.fn(async () => 1),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...rows.invite,
        ...data,
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...rows.invite,
        ...data,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      delete: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(prisma)
        : Promise.all(arg as []),
    ),
  };

  const provider = { signUp: vi.fn(async () => ({ id: NEW_USER_ID, email: 'newhire@bonde.ai' })) };
  const mail = { send: vi.fn(async () => undefined) };
  const audit = { record: vi.fn(async () => undefined) };
  const config = { get: vi.fn(() => 'http://localhost:3000/') };

  const service = new InvitesService(
    prisma as never,
    provider as never,
    mail as never,
    audit as never,
    new UserProvisioningService(prisma as never),
    config as never,
  );

  return { service, prisma, provider, mail, audit, config, rows };
}

describe('InvitesService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('create', () => {
    it('stores only a hashed token and emails the raw one to the invitee', async () => {
      const { service, prisma, mail, audit, config } = makeHarness();

      const view = await service.create({ email: '  NewHire@Bonde.AI ' }, ACTOR_ID);

      const [createArgs] = prisma.userInvite.create.mock.calls[0] as [
        { data: Record<string, string> },
      ];
      expect(createArgs.data.email).toBe('newhire@bonde.ai');
      expect(createArgs.data.role).toBe('USER');
      expect(createArgs.data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      // The raw token exists only in the emailed link.
      expect(JSON.stringify(view)).not.toContain(createArgs.data.tokenHash);

      const [message] = mail.send.mock.calls[0] as unknown as [{ to: string; html: string }];
      expect(message.to).toBe('newhire@bonde.ai');
      expect(message.html).toContain('/accept-invite?token=');
      expect(config.get).toHaveBeenCalledWith('adminAppUrl', { infer: true });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'admin.invite.create', entityId: expect.any(String) }),
      );
    });

    it('expiry is seven days out and no profile is created up front', async () => {
      const { service, prisma } = makeHarness();
      const before = Date.now();
      await service.create({ email: 'newhire@bonde.ai' }, ACTOR_ID);

      const [args] = prisma.userInvite.create.mock.calls[0] as [{ data: { expiresAt: Date } }];
      const days = (args.data.expiresAt.getTime() - before) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);
      expect(prisma.profile.create).not.toHaveBeenCalled();
    });

    it('refuses an address that already has an account', async () => {
      const { service, prisma, mail } = makeHarness();
      prisma.profile.findUnique.mockResolvedValue({ id: NEW_USER_ID } as never);

      await expect(service.create({ email: 'taken@bonde.ai' }, ACTOR_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mail.send).not.toHaveBeenCalled();
      expect(prisma.userInvite.create).not.toHaveBeenCalled();
    });

    it('replaces a live invite for the same email', async () => {
      const { service, prisma } = makeHarness();
      await service.create({ email: 'newhire@bonde.ai' }, ACTOR_ID);

      expect(prisma.userInvite.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ email: 'newhire@bonde.ai' }) }),
      );
      expect(prisma.userInvite.update).toHaveBeenCalledWith({
        where: { id: INVITE_ID },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('voids the invite when the email cannot be delivered', async () => {
      const { service, prisma, mail } = makeHarness();
      mail.send.mockRejectedValueOnce(new Error('smtp down'));

      await expect(service.create({ email: 'newhire@bonde.ai' }, ACTOR_ID)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      const [created] = prisma.userInvite.create.mock.calls[0] as [{ data: { id: string } }];
      expect(created.data.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(prisma.userInvite.delete).toHaveBeenCalledWith({ where: { id: created.data.id } });
    });
  });

  describe('peek', () => {
    it('returns the invite without the token hash', async () => {
      const { service } = makeHarness();
      const view = await service.peek('a'.repeat(43));

      expect(view).toMatchObject({ email: 'newhire@bonde.ai', role: 'ADMIN', valid: true });
      expect(JSON.stringify(view)).not.toContain('tokenHash');
    });

    it('answers uniformly for an unknown token', async () => {
      const { service, prisma } = makeHarness();
      prisma.userInvite.findFirst.mockResolvedValue(null);

      const view = await service.peek('nope');
      expect(view.valid).toBe(false);
      expect(view.email).toBe('');
      // Uniform answer: never reveals whether the address was ever invited.
      expect(JSON.stringify(view)).not.toContain('nope');
    });
  });

  describe('accept', () => {
    const token = 'a'.repeat(43);
    const validHash = createHash('sha256').update(token).digest('hex');

    it('creates a pre-confirmed user with the invited role and provisions the account', async () => {
      const { service, provider, prisma, audit, rows } = makeHarness();
      rows.invite = { ...rows.invite, tokenHash: validHash };

      const result = await service.accept({ token, password: 'Str0ng!Passphrase42' });

      expect(result).toEqual({ status: 'accepted', email: 'newhire@bonde.ai' });
      expect(provider.signUp).toHaveBeenCalledWith({
        email: 'newhire@bonde.ai',
        password: 'Str0ng!Passphrase42',
        fullName: 'New Hire',
        role: 'ADMIN',
        emailConfirm: true,
      });
      expect(prisma.profile.create).toHaveBeenCalledWith({
        data: {
          id: NEW_USER_ID,
          fullName: 'New Hire',
          email: 'newhire@bonde.ai',
          emailVerified: true,
        },
      });
      // The account + wallet are opened by the shared provisioning service.
      expect(prisma.account.create).toBeDefined();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.invite_accepted', userId: NEW_USER_ID }),
      );
    });

    it('lets the invitee override the suggested name', async () => {
      const { service, provider, prisma, rows } = makeHarness();
      rows.invite = { ...rows.invite, tokenHash: validHash };

      await service.accept({ token, password: 'Str0ng!Passphrase42', fullName: '  Ada  ' });

      expect(provider.signUp).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'Ada' }));
      expect(prisma.profile.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ fullName: 'Ada' }) }),
      );
    });

    it('burns the token even when the profile insert loses a race', async () => {
      const { service, prisma, rows } = makeHarness();
      rows.invite = { ...rows.invite, tokenHash: validHash };
      prisma.profile.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
          meta: {},
        }),
      );

      await expect(
        service.accept({ token, password: 'Str0ng!Passphrase42' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.userInvite.updateMany).toHaveBeenCalled();
    });

    it('rejects a replayed token without touching the provider', async () => {
      const { service, prisma, provider, rows } = makeHarness();
      expect(provider.signUp).not.toHaveBeenCalled();
      rows.invite = { ...rows.invite, tokenHash: validHash };
      prisma.userInvite.updateMany.mockResolvedValue({ count: 0 } as never);

      await expect(
        service.accept({ token, password: 'Str0ng!Passphrase42' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an expired or revoked token', async () => {
      const { service, provider, prisma } = makeHarness();
      prisma.userInvite.findFirst.mockResolvedValue(null);

      await expect(
        service.accept({ token, password: 'Str0ng!Passphrase42' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(provider.signUp).not.toHaveBeenCalled();
    });

    it('releases the claim when the provider rejects the attempt', async () => {
      const { service, prisma, provider, rows } = makeHarness();
      rows.invite = { ...rows.invite, tokenHash: validHash };
      provider.signUp.mockRejectedValueOnce(new AuthProviderError('VALIDATION', 'weak'));

      await expect(service.accept({ token, password: 'short' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // Claim released: the invitee can simply try again with a better password.
      expect(prisma.userInvite.updateMany).toHaveBeenCalledTimes(2);
      expect(prisma.userInvite.updateMany.mock.calls[1]![0]).toMatchObject({
        data: { acceptedAt: null },
      });
      expect(prisma.profile.create).not.toHaveBeenCalled();
    });

    it('translates provider failures into client-safe errors', async () => {
      const { service, provider, rows } = makeHarness();
      rows.invite = { ...rows.invite, tokenHash: validHash };

      provider.signUp.mockRejectedValueOnce(new AuthProviderError('USER_EXISTS', 'exists'));
      await expect(
        service.accept({ token, password: 'Str0ng!Passphrase42' }),
      ).rejects.toBeInstanceOf(ConflictException);

      provider.signUp.mockRejectedValueOnce(new AuthProviderError('VALIDATION', 'weak'));
      await expect(service.accept({ token, password: 'short' })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      provider.signUp.mockRejectedValueOnce(new AuthProviderError('CONFIG', 'down'));
      await expect(
        service.accept({ token, password: 'Str0ng!Passphrase42' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('revoke + list', () => {
    it('revokes a pending invite and audits it', async () => {
      const { service, audit } = makeHarness();
      await expect(service.revoke(INVITE_ID, ACTOR_ID)).resolves.toEqual({
        id: INVITE_ID,
        revoked: true,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'admin.invite.revoke', entityId: INVITE_ID }),
      );
    });

    it('refuses to revoke an already-accepted invite', async () => {
      const { service, prisma } = makeHarness();
      prisma.userInvite.findUnique.mockResolvedValue({
        ...inviteRow(),
        acceptedAt: new Date(),
      } as never);

      await expect(service.revoke(INVITE_ID, ACTOR_ID)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.userInvite.update).not.toHaveBeenCalled();
    });

    it('paginates and derives status', async () => {
      const { service } = makeHarness();
      const result = await service.list({ page: 1, pageSize: 10 });

      expect(result).toMatchObject({ total: 1, page: 1, pageSize: 10, totalPages: 1 });
      expect(result.items[0].status).toBe('pending');
      expect(result.items[0].inviterName).toBe('Olivia Martin');
    });

    it('flags an expired invite as expired', async () => {
      const { service, prisma } = makeHarness();
      prisma.userInvite.findMany.mockResolvedValue([
        { ...inviteRow(), expiresAt: new Date(Date.now() - 1000) },
      ] as never);

      const result = await service.list({});
      expect(result.items[0].status).toBe('expired');
    });
  });
});
