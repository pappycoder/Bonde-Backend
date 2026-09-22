import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { scryptSync } from 'node:crypto';
import { PasscodeService } from './passcode.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PASSCODE = '1234';
const SALT = 'aa'.repeat(16);
const HASH = scryptSync(PASSCODE, SALT, 64).toString('hex');

const PASSCODE_ROW = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId: USER_ID,
  salt: SALT,
  hash: HASH,
  failedAttempts: 0,
  lockedUntil: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const passcode = {
    findUnique: vi.fn(async () => PASSCODE_ROW),
    create: vi.fn(async (args) => ({ ...PASSCODE_ROW, ...args.data })),
    update: vi.fn(async (args) => ({ ...PASSCODE_ROW, ...args.data })),
    ...overrides.passcode,
  };
  const prisma = { passcode };
  const config = { get: vi.fn(() => ({ maxAttempts: 5, lockMinutes: 15 })) };
  const service = new PasscodeService(prisma as never, config as never);
  return { service, passcode };
}

describe('PasscodeService.getStatus', () => {
  it('is false when no row exists', async () => {
    const { service, passcode } = makeService();
    passcode.findUnique.mockResolvedValue(null);
    await expect(service.getStatus(USER_ID)).resolves.toEqual({ hasPasscode: false });
  });

  it('is true once a row exists', async () => {
    const { service } = makeService();
    await expect(service.getStatus(USER_ID)).resolves.toEqual({ hasPasscode: true });
  });
});

describe('PasscodeService.create', () => {
  it('stores a salted hash and never the plaintext', async () => {
    const { service, passcode } = makeService();
    await service.create(USER_ID, PASSCODE);
    const data = passcode.create.mock.calls[0][0].data;
    expect(data.userId).toBe(USER_ID);
    expect(data.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(data.hash).not.toBe(PASSCODE);
  });

  it('maps a duplicate userId to 409', async () => {
    const { service, passcode } = makeService();
    passcode.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(service.create(USER_ID, PASSCODE)).rejects.toThrow(ConflictException);
  });
});

describe('PasscodeService.update', () => {
  it('404s when no passcode is set', async () => {
    const { service, passcode } = makeService();
    passcode.findUnique.mockResolvedValue(null);
    await expect(service.update(USER_ID, PASSCODE, '5678')).rejects.toThrow(NotFoundException);
  });

  it('rejects a wrong current passcode', async () => {
    const { service } = makeService();
    await expect(service.update(USER_ID, '9999', '5678')).rejects.toThrow(UnauthorizedException);
  });

  it('replaces the hash after a correct current passcode', async () => {
    const { service, passcode } = makeService();
    await service.update(USER_ID, PASSCODE, '5678');
    expect(passcode.update).toHaveBeenCalled();
    const data = passcode.update.mock.calls[0][0].data;
    expect(data.failedAttempts).toBe(0);
    expect(data.lockedUntil).toBeNull();
    expect(data.hash).not.toBe(PASSCODE_ROW.hash);
  });
});

describe('PasscodeService.validate', () => {
  it('accepts the right passcode and resets counters', async () => {
    const { service, passcode } = makeService();
    const row = { ...PASSCODE_ROW, failedAttempts: 2 };
    passcode.findUnique.mockResolvedValue(row);
    await expect(service.validate(USER_ID, PASSCODE)).resolves.toEqual({ valid: true });
    expect(passcode.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { failedAttempts: 0, lockedUntil: null },
      }),
    );
  });

  it('rejects a wrong passcode and increments the counter', async () => {
    const { service, passcode } = makeService();
    passcode.findUnique.mockResolvedValue({ ...PASSCODE_ROW, failedAttempts: 1 });
    await expect(service.validate(USER_ID, '9999')).rejects.toThrow(UnauthorizedException);
    expect(passcode.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ failedAttempts: 2 }) }),
    );
  });

  it('locks after the max attempts are exhausted', async () => {
    const { service, passcode } = makeService();
    passcode.findUnique.mockResolvedValue({ ...PASSCODE_ROW, failedAttempts: 4 });
    await expect(service.validate(USER_ID, '9999')).rejects.toThrow(
      new UnauthorizedException('Too many failed attempts. Passcode locked for 15 minutes'),
    );
    const data = passcode.update.mock.calls[0][0].data;
    expect(data.failedAttempts).toBe(0);
    expect(data.lockedUntil).not.toBeNull();
  });

  it('stays locked until the window expires', async () => {
    const { service, passcode } = makeService();
    passcode.findUnique.mockResolvedValue({
      ...PASSCODE_ROW,
      lockedUntil: new Date(Date.now() + 60_000),
    });
    await expect(service.validate(USER_ID, PASSCODE)).rejects.toThrow(UnauthorizedException);
    expect(passcode.update).not.toHaveBeenCalled();
  });
});
