import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import otplib from 'otplib';
import { TwoFactorService } from './two-factor.service.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import type { AppConfig } from '../../../config/configuration.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const KEY = 'a'.repeat(64);

type StoredRow = {
  id: string;
  userId: string;
  secretEnc: string;
  recoveryHashes: string[];
  enabledAt: Date | null;
  lastUsedStep: number;
};

/** In-memory stand-in for the `two_factors` table. */
function makeService(options: { row?: 'none' | 'pending' | 'enabled' } = {}) {
  const preset = options.row ?? 'enabled';
  let row: StoredRow | null =
    preset === 'none'
      ? null
      : {
          id: '22222222-2222-4222-8222-222222222222',
          userId: USER_ID,
          secretEnc: '',
          recoveryHashes: [],
          enabledAt: preset === 'enabled' ? new Date('2026-09-26T10:00:00.000Z') : null,
          lastUsedStep: 0,
        };

  const prisma = {
    twoFactor: {
      findUnique: vi.fn(async () => (row ? { ...row } : null)),
      upsert: vi.fn(async (args: { create: StoredRow; update: Partial<StoredRow> }) => {
        row = row ? { ...row, ...args.update } : args.create;
        return { ...row };
      }),
      update: vi.fn(async (args: { data: Partial<StoredRow> }) => {
        row = { ...(row as StoredRow), ...args.data };
        return { ...row };
      }),
      deleteMany: vi.fn(async () => {
        row = null;
        return { count: 1 };
      }),
    },
  };

  const config = {
    get: vi.fn(() => KEY),
  } as unknown as ConfigService<AppConfig, true>;

  const service = new TwoFactorService(prisma as unknown as PrismaService, config);
  return {
    service,
    prisma,
    config,
    stored: () => row,
  };
}

/** A code that is valid right now for `secret`. */
function currentCode(secret: string): string {
  return otplib.authenticator.generate(secret);
}

describe('TwoFactorService.status / isEnabled', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports an account with no row as disabled', async () => {
    const { service } = makeService({ row: 'none' });
    expect(await service.status(USER_ID)).toEqual({
      enabled: false,
      enrolledAt: null,
      recoveryCodesRemaining: 0,
    });
    expect(await service.isEnabled(USER_ID)).toBe(false);
  });

  it('reports a half-finished enrolment as not yet on', async () => {
    const { service } = makeService({ row: 'pending' });
    expect(await service.isEnabled(USER_ID)).toBe(false);
    expect(await service.status(USER_ID)).toEqual({
      enabled: false,
      enrolledAt: null,
      recoveryCodesRemaining: 0,
    });
  });

  it('reports an enrolled account with its enrolment time', async () => {
    const { service } = makeService({ row: 'enabled' });
    expect(await service.isEnabled(USER_ID)).toBe(true);
    expect(await service.status(USER_ID)).toEqual({
      enabled: true,
      enrolledAt: '2026-09-26T10:00:00.000Z',
      recoveryCodesRemaining: 0,
    });
  });
});

describe('TwoFactorService.enrolment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores the secret encrypted and returns an otpauth uri', async () => {
    const { service, stored } = makeService({ row: 'none' });
    const setup = await service.startSetup(USER_ID, 'amina@bonde.app');

    expect(setup.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.otpauthUri).toContain('otpauth://totp/Bonde:');
    expect(setup.otpauthUri).toContain(`secret=${setup.secret}`);
    expect(setup.otpauthUri).toContain('issuer=Bonde');

    // The row keeps the secret encrypted, never in the clear.
    expect(stored()?.secretEnc).toMatch(/^enc::/);
    expect(stored()?.secretEnc).not.toContain(setup.secret);
  });

  it('restarts enrolment over an existing row and clears the enabled flag', async () => {
    const { service, stored } = makeService({ row: 'enabled' });
    await service.startSetup(USER_ID, 'amina@bonde.app');

    expect(stored()?.enabledAt).toBeNull();
    expect(stored()?.recoveryHashes).toEqual([]);
    expect(stored()?.lastUsedStep).toBe(0);
  });

  it('rejects an enable before setup has started', async () => {
    const { service } = makeService({ row: 'none' });
    await expect(service.enable(USER_ID, '123456')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a second enable on an already-enrolled account', async () => {
    const { service } = makeService({ row: 'enabled' });
    await expect(service.enable(USER_ID, '123456')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a code the authenticator app never produced', async () => {
    const { service, stored } = makeService({ row: 'pending' });
    await service.startSetup(USER_ID, 'amina@bonde.app');

    await expect(service.enable(USER_ID, '000000')).rejects.toBeInstanceOf(UnauthorizedException);
    // A failed attempt must not turn the factor on.
    expect(stored()?.enabledAt).toBeNull();
  });

  it('rejects a malformed code without touching the store', async () => {
    const { service } = makeService({ row: 'pending' });
    await service.startSetup(USER_ID, 'amina@bonde.app');

    await expect(service.enable(USER_ID, 'abcdef')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('enables on the first valid code and returns 10 recovery codes', async () => {
    const { service, stored } = makeService({ row: 'pending' });
    const setup = await service.startSetup(USER_ID, 'amina@bonde.app');

    const result = await service.enable(USER_ID, currentCode(setup.secret));

    expect(result.recoveryCodes).toHaveLength(10);
    for (const code of result.recoveryCodes) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    }
    expect(new Set(result.recoveryCodes).size).toBe(10);
    // Codes are only kept as digests.
    expect(stored()?.recoveryHashes).toHaveLength(10);
    for (const code of result.recoveryCodes) {
      expect(JSON.stringify(stored())).not.toContain(code);
    }
    expect(stored()?.enabledAt).toBeInstanceOf(Date);
  });
});

describe('TwoFactorService.verify', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401s when the account has no second factor', async () => {
    const { service } = makeService({ row: 'none' });
    await expect(service.verify(USER_ID, '123456')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401s while enrolment is unfinished', async () => {
    const { service } = makeService({ row: 'pending' });
    await expect(service.verify(USER_ID, '123456')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a current code once per time step', async () => {
    const { service, stored } = makeService({ row: 'pending' });
    const setup = await service.startSetup(USER_ID, 'amina@bonde.app');
    await service.enable(USER_ID, currentCode(setup.secret));

    // Pretend the factor was enrolled a while ago, so the step is not consumed.
    stored()!.lastUsedStep = 0;

    expect(await service.verify(USER_ID, currentCode(setup.secret))).toBe('totp');
    expect(stored()!.lastUsedStep).toBeGreaterThan(0);
  });

  it('rejects a replayed code inside the same time step', async () => {
    const { service } = makeService({ row: 'pending' });
    const setup = await service.startSetup(USER_ID, 'amina@bonde.app');
    await service.enable(USER_ID, currentCode(setup.secret));

    await expect(service.verify(USER_ID, currentCode(setup.secret))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a wrong code', async () => {
    const { service, stored } = makeService({ row: 'pending' });
    const setup = await service.startSetup(USER_ID, 'amina@bonde.app');
    await service.enable(USER_ID, currentCode(setup.secret));
    stored()!.lastUsedStep = 0;

    await expect(service.verify(USER_ID, '000000')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('consumes a recovery code once and ignores case/format sloppiness', async () => {
    const { service, stored } = makeService({ row: 'pending' });
    const setup = await service.startSetup(USER_ID, 'amina@bonde.app');
    const { recoveryCodes } = await service.enable(USER_ID, currentCode(setup.secret));
    const code = recoveryCodes[0]!;

    expect(await service.verify(USER_ID, ` ${code.toLowerCase().replace('-', ' ')} `)).toBe(
      'recovery',
    );
    expect(stored()!.recoveryHashes).toHaveLength(9);
    await expect(service.verify(USER_ID, code)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('TwoFactorService.disable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes the row so the account falls back to password only', async () => {
    const { service, stored } = makeService({ row: 'enabled' });
    await service.disable(USER_ID);
    expect(stored()).toBeNull();
    expect(await service.isEnabled(USER_ID)).toBe(false);
  });
});
