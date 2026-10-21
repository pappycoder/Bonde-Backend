import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PasscodeService } from '../passcode/passcode.service.js';
import { DEFAULT_PREFERENCES, PreferencesDto, SupportRequestDto } from './preferences.dto.js';

@Injectable()
export class ProfileHubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passcode: PasscodeService,
  ) {}
  async preferences(userId: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });
    if (!profile) throw new NotFoundException('Profile not found');
    const raw = profile.preferences;
    return {
      ...DEFAULT_PREFERENCES,
      ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}),
    };
  }
  async updatePreferences(userId: string, dto: PreferencesDto) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "profiles" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      const profile = await tx.profile.findUnique({
        where: { id: userId },
        select: { preferences: true },
      });
      if (!profile) throw new NotFoundException('Profile not found');
      const raw = profile.preferences;
      const existing = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const values = { ...DEFAULT_PREFERENCES, ...existing, ...dto };
      await tx.profile.update({
        where: { id: userId },
        data: { preferences: values as Prisma.InputJsonValue },
      });
      return values;
    });
  }
  async support(userId: string, dto: SupportRequestDto) {
    return this.prisma.supportTicket.create({
      data: {
        id: randomUUID(),
        userId,
        subject: dto.subject.trim(),
        messages: { create: { id: randomUUID(), role: 'USER', body: dto.message.trim() } },
      },
      select: { id: true, subject: true, status: true, createdAt: true },
    });
  }
  async tickets(userId: string) {
    return this.prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: { id: true, subject: true, status: true, updatedAt: true },
    });
  }
  async ticket(userId: string, id: string) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { userId, id },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, body: true, role: true, createdAt: true },
        },
      },
    });
    if (!ticket) throw new NotFoundException('Support ticket not found');
    return ticket;
  }
  async deletionRequest(userId: string, code: string) {
    await this.passcode.validate(userId, code);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "profiles" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      const profile = await tx.profile.findUnique({ where: { id: userId } });
      if (!profile) throw new NotFoundException('Profile not found');
      const [wallets, cards, pending, approvals, orders] = await Promise.all([
        tx.wallet.count({ where: { account: { userId }, balance: { not: 0 } } }),
        tx.card.count({ where: { userId, balance: { not: 0 } } }),
        tx.transaction.count({ where: { userId, status: 'PENDING' } }),
        tx.transactionApproval.count({ where: { transaction: { userId }, status: 'PENDING' } }),
        tx.billingOrder.count({ where: { userId, status: 'PENDING' } }),
      ]);
      if (wallets || cards)
        throw new BadRequestException(
          'Withdraw remaining wallet and card funds before requesting deletion.',
        );
      if (pending || approvals || orders)
        throw new ConflictException(
          'Settle pending transactions and approvals before requesting deletion.',
        );
      if (
        profile.cardPlan === 'PREMIUM' &&
        !profile.billingCancelAtPeriodEnd &&
        (!profile.cardPlanExpiresAt || profile.cardPlanExpiresAt > new Date())
      )
        throw new ConflictException('Cancel your subscription before requesting deletion.');
      const subject = 'Account deletion request';
      const existing = await tx.supportTicket.findFirst({
        where: { userId, subject, status: { in: ['OPEN', 'PENDING'] } },
        select: { id: true, status: true },
      });
      if (existing) return { ...existing, requested: true };
      const result = await tx.supportTicket.create({
        data: {
          id: randomUUID(),
          userId,
          subject,
          priority: 'HIGH',
          messages: {
            create: {
              id: randomUUID(),
              role: 'USER',
              body: 'Account deletion requested after passcode verification. Review identity, legal retention obligations and financial state before processing. No account or financial records have been deleted.',
            },
          },
        },
        select: { id: true, status: true },
      });
      return { ...result, requested: true };
    });
  }
}
