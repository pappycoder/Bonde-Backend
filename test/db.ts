import type { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Shared constants + fixtures for DB-backed e2e suites.
 *
 * e2e tests run against the LOCAL dockerized Postgres (docker-compose
 * `postgres` service, port 5433) — the app-under-test Prisma client is pointed
 * at it by overriding DATABASE_URL / DIRECT_URL at boot time. The Vitest
 * global setup owns migrating + seeding this instance.
 */
export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://bonde:bonde@localhost:5433/bonde';

/** Seeded profile (JWT subject used by most suites). */
export const SEED_USER_ID = '11111111-1111-4111-8111-111111111111';
export const SEED_USER_PHONE = '+2348000000001';
export const SEED_USER_EMAIL = 'me@bonde.app';

/** Second profile — used for ownership/conflict assertions. */
export const SEED_OTHER_ID = '22222222-2222-4222-8222-222222222222';
export const SEED_OTHER_PHONE = '+2348000000002';

export const SEED_PROVIDER_ID = '33333333-3333-4333-8333-333333333333';
export const SEED_CARD_ID = '44444444-4444-4444-8444-444444444444';
export const SEED_CHAT_ID = '55555555-5555-4555-8555-555555555555';

type AnyPrisma = PrismaService | PrismaClient;

const PHYSICAL_TABLES = [
  'transaction_approvals',
  'transactions',
  'transaction_thresholds',
  'otp_codes',
  'notifications',
  'messages',
  'chats',
  'card_categories',
  'card_locks',
  'cards',
  'card_providers',
  'biometric_devices',
  'audit_logs',
  'wallets',
  'accounts',
  'profiles',
];

export async function truncateAll(prisma: AnyPrisma): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${PHYSICAL_TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`,
  );
}

/** Baseline rows required by the registry/FK graph. Idempotent via upsert. */
export async function seedBaseFixtures(prisma: AnyPrisma): Promise<void> {
  await prisma.profile.createMany({
    data: [
      {
        id: SEED_USER_ID,
        fullName: 'Amina Sule',
        phone: SEED_USER_PHONE,
        phoneVerified: true,
        emailVerified: true,
      },
      {
        id: SEED_OTHER_ID,
        fullName: 'Chidi Okafor',
        phone: SEED_OTHER_PHONE,
        phoneVerified: true,
        emailVerified: false,
      },
    ],
    skipDuplicates: true,
  });

  await prisma.cardProvider.create({
    data: {
      id: SEED_PROVIDER_ID,
      name: 'Test Provider',
      baseUrl: 'https://example.provider.test',
      config: { apiKey: 'top-secret' },
    },
  });

  await prisma.card.create({
    data: {
      id: SEED_CARD_ID,
      userId: SEED_USER_ID,
      providerId: SEED_PROVIDER_ID,
      cardNumberEncrypted: 'enc::ciphertext',
      cardNumberLast4: '4242',
      cardType: 'virtual',
      expirationType: 'monthly',
      expirationDate: new Date('2030-01-01T00:00:00.000Z'),
    },
  });

  await prisma.chat.create({
    data: { id: SEED_CHAT_ID, userId: SEED_USER_ID, title: 'Onboarding chat' },
  });
}
