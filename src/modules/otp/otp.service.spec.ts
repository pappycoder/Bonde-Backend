import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { OtpChannel } from '@prisma/client';
import { OtpService } from './otp.service.js';
import { OtpSendError } from './otp-sender.interface.js';
import type { OtpSendRequest } from './otp-sender.interface.js';
import type { AuthPrincipal } from '../auth/principal/auth-principal.js';

const digest = (code: string): string => createHash('sha256').update(code).digest('hex');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'user@bonde.app';
const PHONE = '+2348000000000';

const PRINCIPAL: AuthPrincipal = {
  userId: USER_ID,
  email: EMAIL,
  phone: PHONE,
  role: 'USER',
  appMetadata: {},
  userMetadata: {},
};

type SenderStub = { send: ReturnType<typeof vi.fn<(request: OtpSendRequest) => Promise<void>>> };

interface OtpDelegates {
  updateMany: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

interface ProfileDelegates {
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

function makeService(
  opts: {
    sender?: SenderStub;
    profile?: Partial<ProfileDelegates>;
  } = {},
) {
  const captured: string[] = [];
  const sender: SenderStub =
    opts.sender ??
    ({
      send: vi.fn(async (request: OtpSendRequest) => {
        captured.push(request.code);
      }),
    } as SenderStub);

  const otpCode = {
    updateMany: vi.fn(async () => ({ count: 1 })),
    create: vi.fn(async (args) => ({ ...args.data, id: 'otp-created-id' })),
    findFirst: vi.fn(async () => null),
    update: vi.fn(async (args) => ({ id: args.where.id, ...args.data })),
  } satisfies OtpDelegates;

  const profile = {
    findUnique: vi.fn(async () => ({ phone: PHONE })),
    update: vi.fn(async () => ({})),
    ...opts.profile,
  } satisfies ProfileDelegates;

  const prisma = {
    otpCode,
    profile,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ otpCode, profile })),
  };

  const service = new OtpService(prisma as never, sender as never);
  return { service, sender, captured, prisma };
}

describe('OtpService.send', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a target that does not belong to the principal', async () => {
    const { service, sender } = makeService();
    await expect(
      service.send(PRINCIPAL, { channel: OtpChannel.PHONE, target: '+2348999999999' }),
    ).rejects.toThrow(BadRequestException);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('sends a 6-digit code and stores only its SHA-256 digest', async () => {
    const { service, captured, prisma } = makeService();
    await expect(
      service.send(PRINCIPAL, { channel: OtpChannel.PHONE, target: PHONE }),
    ).resolves.toEqual({ status: 'sent' });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatch(/^[0-9]{6}$/);
    const created = prisma.otpCode.create.mock.calls[0][0] as { data: { code: string } };
    expect(created.data.code).toMatch(/^[0-9a-f]{64}$/); // sha-256 hex, never plaintext
    expect(created.data.code).not.toBe(captured[0]);
  });

  it('invalidates previous unused codes for the same channel', async () => {
    const { service, prisma } = makeService();
    await service.send(PRINCIPAL, { channel: OtpChannel.PHONE, target: PHONE });
    expect(prisma.otpCode.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, channel: OtpChannel.PHONE, used: false },
      data: { used: true },
    });
  });

  it('fails closed (503) and invalidates the code when delivery fails', async () => {
    const failingSender: SenderStub = {
      send: vi.fn(async () => {
        throw new OtpSendError('down');
      }),
    };
    const { service, prisma } = makeService({ sender: failingSender });

    await expect(
      service.send(PRINCIPAL, { channel: OtpChannel.PHONE, target: PHONE }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.otpCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'otp-created-id' }, data: { used: true } }),
    );
  });
});

describe('OtpService.verify', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an unknown/expired code', async () => {
    const { service } = makeService();
    await expect(
      service.verify(PRINCIPAL, { channel: OtpChannel.PHONE, target: PHONE, code: '000000' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a wrong code', async () => {
    const { service, captured, prisma } = makeService();
    await service.send(PRINCIPAL, { channel: OtpChannel.PHONE, target: PHONE });
    const sent = captured[0];

    const wrong = sent === '000000' ? '000001' : '000000';
    (prisma.otpCode.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'otp-1',
      userId: USER_ID,
      channel: OtpChannel.PHONE,
      code: digest(sent),
      expiresAt: new Date(Date.now() + 60_000),
      used: false,
      createdAt: new Date(),
    });
    await expect(
      service.verify(PRINCIPAL, { channel: OtpChannel.PHONE, target: PHONE, code: wrong }),
    ).rejects.toThrow(BadRequestException);
  });

  it('verifies, marks the code single-use, and flags the phone verified', async () => {
    const { service, captured, prisma } = makeService();
    await service.send(PRINCIPAL, { channel: OtpChannel.PHONE, target: PHONE });
    const sent = captured[0];

    (prisma.otpCode.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'otp-1',
      userId: USER_ID,
      channel: OtpChannel.PHONE,
      code: digest(sent),
      expiresAt: new Date(Date.now() + 60_000),
      used: false,
      createdAt: new Date(),
    });

    await expect(
      service.verify(PRINCIPAL, { channel: OtpChannel.PHONE, target: PHONE, code: sent }),
    ).resolves.toEqual({ verified: true });

    expect(prisma.otpCode.update).toHaveBeenCalledWith({
      where: { id: 'otp-1' },
      data: { used: true },
    });
    expect(prisma.profile.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { phoneVerified: true },
    });
  });

  it('marks emailVerified on a successful email verification', async () => {
    const { service, captured, prisma } = makeService();
    await expect(
      service.send(PRINCIPAL, { channel: OtpChannel.EMAIL, target: EMAIL }),
    ).resolves.toEqual({ status: 'sent' });

    (prisma.otpCode.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'otp-2',
      userId: USER_ID,
      channel: OtpChannel.EMAIL,
      code: digest(captured[0]),
      expiresAt: new Date(Date.now() + 60_000),
      used: false,
      createdAt: new Date(),
    });

    await expect(
      service.verify(PRINCIPAL, { channel: OtpChannel.EMAIL, target: EMAIL, code: captured[0] }),
    ).resolves.toEqual({ verified: true });
    expect(prisma.profile.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { emailVerified: true },
    });
  });

  it('does not mark a phone verified unless it matches the stored profile phone', async () => {
    const { service, captured, prisma } = makeService({
      profile: { findUnique: vi.fn(async () => ({ phone: '+2348999999999' })) },
    });
    const principal = { ...PRINCIPAL, phone: '+2348000000001' };
    const target = '+2348000000001';

    await service.send(principal, { channel: OtpChannel.PHONE, target });
    (prisma.otpCode.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'otp-3',
      userId: USER_ID,
      channel: OtpChannel.PHONE,
      code: digest(captured[0]),
      expiresAt: new Date(Date.now() + 60_000),
      used: false,
      createdAt: new Date(),
    });

    await service.verify(principal, { channel: OtpChannel.PHONE, target, code: captured[0] });
    expect(prisma.profile.update).not.toHaveBeenCalled();
  });
});
