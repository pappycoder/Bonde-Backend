import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Card, type FinanceMerchantIdentity } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { fingerprint } from './finance.types.js';
import { object, string, SudoClient } from './providers.js';
import { validateRules } from './card-policy.js';

@Injectable()
export class FinanceMerchants {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly sudo: SudoClient,
  ) {}
  async observe(tx: Prisma.TransactionClient, userId: string, raw: Record<string, unknown>) {
    const merchantId = string(raw.merchantId),
      country = string(raw.country).toUpperCase();
    if (!/^[A-Z]{2}$/.test(country) || merchantId.length > 100)
      throw new BadRequestException('Invalid merchant identity');
    const identity = await tx.financeMerchantIdentity.upsert({
      where: {
        environment_merchantId_country: {
          environment: this.config.get('finance').environment,
          merchantId,
          country,
        },
      },
      create: {
        id: randomUUID(),
        environment: this.config.get('finance').environment,
        merchantId,
        country,
        name: string(raw.name),
        mcc: string(raw.category),
      },
      update: {},
    });
    await tx.financeMerchantAccess.upsert({
      where: { userId_identityId: { userId, identityId: identity.id } },
      create: { userId, identityId: identity.id },
      update: {},
    });
    await tx.$queryRaw`SELECT id FROM finance_merchant_identities WHERE id=${identity.id}::uuid FOR SHARE`;
    return tx.financeMerchantIdentity.findUniqueOrThrow({ where: { id: identity.id } });
  }
  async list(userId: string, q = '', cursor?: string) {
    if (cursor && !/^(identity:[0-9a-f-]{36}|catalog:[0-9a-f-]{36}:\d+)$/i.test(cursor))
      throw new BadRequestException('Invalid merchant cursor');
    const identities =
      cursor?.startsWith('catalog:') || !cursor || cursor.startsWith('identity:')
        ? await this.prisma.financeMerchantIdentity.findMany({
            where: {
              revokedAt: null,
              environment: this.config.get('finance').environment,
              access: { some: { userId } },
              ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
              ...(cursor?.startsWith('identity:') ? { id: { gt: cursor.slice(9) } } : {}),
            },
            orderBy: { id: 'asc' },
            take: 51,
          })
        : [];
    const catalogs = cursor?.startsWith('identity:')
      ? []
      : await this.prisma.financeMerchantCatalog.findMany({
          where: {
            status: 'PUBLISHED',
            ...(q ? { label: { contains: q, mode: 'insensitive' as const } } : {}),
            ...(cursor?.startsWith('catalog:') ? { id: { gt: cursor.split(':')[1] } } : {}),
          },
          orderBy: { id: 'asc' },
          take: 51,
        });
    const choices = [
      ...catalogs.map((row) => ({
        id: `catalog:${row.id}:${row.version}`,
        label: row.label,
        source: 'CATALOG',
        country: '',
        descriptor: row.website ?? '',
      })),
      ...identities.map((row) => ({
        id: `identity:${row.id}`,
        label: row.name,
        source: 'ACTIVITY',
        country: row.country,
        descriptor: `${row.name} · ${row.country} · …${row.merchantId.slice(-4)}`,
      })),
    ];
    return { items: choices.slice(0, 50), nextCursor: choices.length > 50 ? choices[49].id : null };
  }

  async resolveRules(
    tx: Prisma.TransactionClient,
    userId: string,
    raw: Record<string, unknown> = {},
  ) {
    if (raw.merchantIds !== undefined)
      throw new BadRequestException('Select verified merchant choices, not raw merchant IDs');
    const { merchantSelections, ...rest } = raw;
    const ids = new Set<string>();
    if (
      merchantSelections !== undefined &&
      (!Array.isArray(merchantSelections) || merchantSelections.length > 20)
    )
      throw new BadRequestException('Invalid merchant selections');
    for (const selection of (merchantSelections ?? []) as unknown[]) {
      if (typeof selection !== 'string') throw new BadRequestException('Invalid merchant choice');
      const parts = selection.split(':');
      if (parts[0] === 'identity' && /^[0-9a-f-]{36}$/i.test(parts[1] ?? '')) {
        await tx.$queryRaw`SELECT id FROM finance_merchant_identities WHERE id=${parts[1]}::uuid FOR SHARE`;
        let row = await tx.financeMerchantIdentity.findFirst({
          where: {
            id: parts[1],
            revokedAt: null,
            environment: this.config.get('finance').environment,
            access: { some: { userId } },
          },
        });
        if (
          !row &&
          (await tx.cardLock.findFirst({
            where: {
              lockType: 'MERCHANT',
              card: { userId, issuer: 'sudo' },
              config: { path: ['merchantIds'], array_contains: [parts[1]] },
            },
          }))
        )
          row = await tx.financeMerchantIdentity.findFirst({
            where: {
              id: parts[1],
              revokedAt: null,
              environment: this.config.get('finance').environment,
            },
          });
        if (!row) throw new BadRequestException('Merchant choice is unavailable');
        ids.add(row.id);
      } else if (
        parts[0] === 'catalog' &&
        /^[0-9a-f-]{36}$/i.test(parts[1] ?? '') &&
        /^\d+$/.test(parts[2] ?? '')
      ) {
        await tx.$queryRaw`SELECT id FROM finance_merchant_catalog WHERE id=${parts[1]}::uuid FOR SHARE`;
        const row = await tx.financeMerchantCatalog.findFirst({
          where: { id: parts[1], version: Number(parts[2]), status: 'PUBLISHED' },
        });
        if (!row)
          throw new ConflictException('Merchant catalog changed. Review your selection again');
        for (const identity of [...row.identityIds].sort())
          await tx.$queryRaw`SELECT id FROM finance_merchant_identities WHERE id=${identity}::uuid FOR SHARE`;
        const valid = await tx.financeMerchantIdentity.count({
          where: {
            id: { in: row.identityIds },
            revokedAt: null,
            environment: this.config.get('finance').environment,
          },
        });
        if (!row.identityIds.length || valid !== row.identityIds.length)
          throw new ConflictException('Merchant identities require review');
        row.identityIds.forEach((id) => ids.add(id));
      } else throw new BadRequestException('Invalid merchant choice');
    }
    return validateRules({
      ...rest,
      ...(rest.type === 'MERCHANT' ? { merchantIds: [...ids] } : {}),
    });
  }
  async start(tx: Prisma.TransactionClient, card: Card, label: string, version: number) {
    if (card.creationLockType !== 'MERCHANT' || version !== card.rulesVersion || card.retiredAt)
      throw new ConflictException('Reload this merchant card');
    if (!label.trim() || label.length > 100)
      throw new BadRequestException('Enter the intended merchant');
    await tx.financeMerchantEnrollment.updateMany({
      where: { cardId: card.id, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
    return tx.financeMerchantEnrollment.create({
      data: {
        id: randomUUID(),
        userId: card.userId,
        cardId: card.id,
        label: label.trim(),
        rulesVersion: version,
        expiresAt: new Date(Date.now() + 600000),
      },
    });
  }
  async candidate(
    tx: Prisma.TransactionClient,
    card: Card,
    identity: FinanceMerchantIdentity,
    authorizationId: string,
    facts: unknown,
  ) {
    const enrollment = await tx.financeMerchantEnrollment.findFirst({
      where: {
        cardId: card.id,
        userId: card.userId,
        status: 'PENDING',
        rulesVersion: card.rulesVersion,
        expiresAt: { gt: new Date() },
      },
    });
    if (!enrollment || identity.revokedAt) return;
    if ((await tx.financeMerchantCandidate.count({ where: { enrollmentId: enrollment.id } })) >= 20)
      return;
    await tx.financeMerchantCandidate.upsert({
      where: { enrollmentId_authorizationId: { enrollmentId: enrollment.id, authorizationId } },
      create: {
        id: randomUUID(),
        enrollmentId: enrollment.id,
        identityId: identity.id,
        authorizationId,
        requestHash: fingerprint(facts),
      },
      update: {},
    });
  }
  async current(userId: string, cardId: string) {
    const card = await this.prisma.card.findFirst({
      where: { id: cardId, userId, issuer: 'sudo' },
    });
    if (!card) throw new NotFoundException('Card not found');
    const enrollment = await this.prisma.financeMerchantEnrollment.findFirst({
      where: { cardId, userId },
      orderBy: { createdAt: 'desc' },
      include: {
        candidates: {
          include: {
            identity: true,
            authorization: { select: { amount: true, currency: true, requestType: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!enrollment) return { status: 'NONE', candidates: [] };
    return {
      ...enrollment,
      status:
        enrollment.status === 'PENDING' && enrollment.expiresAt <= new Date()
          ? 'EXPIRED'
          : enrollment.status,
      candidates: enrollment.candidates.map((row) => ({
        id: row.id,
        label: row.identity.name,
        country: row.identity.country,
        descriptor: row.identity.merchantId,
        amount: row.authorization.amount.toFixed(2),
        currency: row.authorization.currency,
        requestType: row.authorization.requestType,
      })),
    };
  }
  async bind(
    tx: Prisma.TransactionClient,
    card: Card,
    enrollmentId: string,
    candidateId: string,
    version: number,
  ) {
    if (card.retiredAt || version !== card.rulesVersion || card.creationLockType !== 'MERCHANT')
      throw new ConflictException('Reload this merchant card');
    const candidate = await tx.financeMerchantCandidate.findFirst({
      where: {
        id: candidateId,
        enrollmentId,
        enrollment: {
          userId: card.userId,
          cardId: card.id,
          status: 'PENDING',
          rulesVersion: version,
          expiresAt: { gt: new Date() },
        },
      },
      include: { identity: true, authorization: true },
    });
    if (candidate)
      await tx.$queryRaw`SELECT id FROM finance_merchant_identities WHERE id=${candidate.identityId}::uuid FOR SHARE`;
    if (
      !candidate ||
      (await tx.financeMerchantIdentity.findUniqueOrThrow({ where: { id: candidate.identityId } }))
        .revokedAt
    )
      throw new ConflictException('This merchant confirmation has expired');
    if (
      candidate.requestHash !==
      fingerprint({
        amount: candidate.authorization.amount.toFixed(2),
        currency: candidate.authorization.currency,
        identityId: candidate.identityId,
        requestType: candidate.authorization.requestType,
      })
    )
      throw new ConflictException('Merchant evidence changed. Start setup again');
    const lock = await tx.cardLock.findFirstOrThrow({
      where: { cardId: card.id, lockType: 'MERCHANT', isActive: true },
    });
    const rule = validateRules(lock.config as Record<string, unknown>);
    const ids = [...new Set([...(rule.merchantIds ?? []), candidate.identityId])];
    const { pendingMerchantLabel: _label, ...bound } = rule;
    await tx.cardLock.update({
      where: { id: lock.id },
      data: { config: { ...bound, merchantIds: ids } as Prisma.InputJsonValue },
    });
    await tx.card.update({ where: { id: card.id }, data: { rulesVersion: { increment: 1 } } });
    await tx.financeMerchantEnrollment.update({
      where: { id: enrollmentId },
      data: { status: 'BOUND' },
    });
    await tx.financeMerchantEnrollment.updateMany({
      where: { cardId: card.id, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
    await tx.cardHistory.create({
      data: {
        id: randomUUID(),
        cardId: card.id,
        event: 'merchant.bound',
        changes: { identityId: candidate.identityId, label: candidate.identity.name },
      },
    });
  }
  async catalog() {
    return this.prisma.financeMerchantCatalog.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
  }
  async reviewCatalog(
    actor: string,
    data: { id?: string; label: string; website?: string; authorizationIds: string[] },
  ) {
    if (
      !data.label.trim() ||
      data.label.length > 100 ||
      !data.authorizationIds.length ||
      data.authorizationIds.length > 20
    )
      throw new BadRequestException('Provide a label and provider evidence');
    if (data.website && !/^https:\/\/[a-z0-9.-]+\/?$/i.test(data.website))
      throw new BadRequestException('Use an HTTPS merchant website origin');
    const evidence: Array<{
      userId: string;
      merchant: Record<string, unknown>;
      authorizationId: string;
    }> = [];
    for (const id of data.authorizationIds) {
      const raw = object(await this.sudo.call(`/authorizations/${encodeURIComponent(id)}`));
      if (raw._id !== id) throw new BadRequestException('Invalid provider evidence');
      const card = await this.prisma.card.findFirst({
        where: { issuer: 'sudo', externalReferenceId: string(object(raw.card)._id) },
      });
      if (!card) throw new BadRequestException('Evidence must belong to this card programme');
      evidence.push({ userId: card.userId, merchant: object(raw.merchant), authorizationId: id });
    }
    return this.prisma.$transaction(async (tx) => {
      const identities = [];
      for (const row of evidence) identities.push(await this.observe(tx, row.userId, row.merchant));
      const catalogId = data.id ?? randomUUID();
      const row = await tx.financeMerchantCatalog.upsert({
        where: { id: catalogId },
        create: {
          id: catalogId,
          label: data.label.trim(),
          website: data.website,
          identityIds: [...new Set(identities.map((row) => row.id))],
          evidence: data.authorizationIds,
          status: 'DRAFT',
        },
        update: {
          label: data.label.trim(),
          website: data.website,
          identityIds: [...new Set(identities.map((row) => row.id))],
          evidence: data.authorizationIds,
          status: 'DRAFT',
          version: { increment: 1 },
        },
      });
      await tx.auditLog.create({
        data: {
          id: randomUUID(),
          userId: actor,
          action: 'admin.finance.merchant.review',
          entityType: 'merchant_catalog',
          entityId: row.id,
        },
      });
      return row;
    });
  }
  async publish(actor: string, id: string, revoke: boolean, version: number) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.financeMerchantCatalog.findUniqueOrThrow({ where: { id } });
      if (row.version !== version)
        throw new ConflictException('Catalog changed. Refresh and review the evidence again');
      if (!row.identityIds.length) throw new BadRequestException('Verified evidence is required');
      if (revoke) {
        await tx.financeMerchantIdentity.updateMany({
          where: { id: { in: row.identityIds } },
          data: { revokedAt: new Date() },
        });
        await tx.financeMerchantCatalog.updateMany({
          where: { id: { not: id }, identityIds: { hasSome: row.identityIds } },
          data: { status: 'REVOKED', version: { increment: 1 } },
        });
      } else if (
        (await tx.financeMerchantIdentity.count({
          where: {
            id: { in: row.identityIds },
            revokedAt: null,
            environment: this.config.get('finance').environment,
          },
        })) !== row.identityIds.length
      )
        throw new BadRequestException('Reconfirm revoked identities before publication');
      const updated = await tx.financeMerchantCatalog.update({
        where: { id },
        data: { status: revoke ? 'REVOKED' : 'PUBLISHED', version: { increment: 1 } },
      });
      if (revoke) {
        const locks = await tx.cardLock.findMany({
          where: { lockType: 'MERCHANT', isActive: true },
          include: { card: { select: { userId: true } } },
        });
        for (const lock of locks)
          if (
            ((lock.config as { merchantIds?: string[] }).merchantIds ?? []).some((identity) =>
              row.identityIds.includes(identity),
            )
          )
            await tx.notification.create({
              data: {
                id: randomUUID(),
                userId: lock.card.userId,
                type: 'CARD',
                title: 'Merchant selection needs review',
                content:
                  'A merchant identity on your card is no longer approved. Confirm an updated selection before retrying.',
                metadata: { entityType: 'card', entityId: lock.cardId, live: true },
              },
            });
      }
      await tx.auditLog.create({
        data: {
          id: randomUUID(),
          userId: actor,
          action: revoke ? 'admin.finance.merchant.revoke' : 'admin.finance.merchant.publish',
          entityType: 'merchant_catalog',
          entityId: id,
        },
      });
      return updated;
    });
  }
}
