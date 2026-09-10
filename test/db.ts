import type { PrismaClient } from '@prisma/client';
import { AccountType } from '@prisma/client';
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
export const SEED_OTHER_EMAIL = 'other@bonde.app';

export const SEED_PROVIDER_ID = '33333333-3333-4333-8333-333333333333';
export const SEED_CARD_ID = '44444444-4444-4444-8444-444444444444';
export const SEED_CHAT_ID = '55555555-5555-4555-8555-555555555555';
export const SEED_ACCOUNT_ID = '66666666-6666-4666-8666-666666666666';
export const SEED_WALLET_ID = '77777777-7777-4777-8777-777777777777';
export const SEED_TRANSACTION_ID = '88888888-8888-4888-8888-888888888888';
export const SEED_APPROVAL_ID = '99999999-9999-4999-8999-999999999999';

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
        email: SEED_USER_EMAIL,
        phone: SEED_USER_PHONE,
        phoneVerified: true,
        emailVerified: true,
      },
      {
        id: SEED_OTHER_ID,
        fullName: 'Chidi Okafor',
        email: SEED_OTHER_EMAIL,
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

  await prisma.message.createMany({
    data: [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        chatId: SEED_CHAT_ID,
        role: 'USER',
        content: 'Hello, can you help me budget?',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        chatId: SEED_CHAT_ID,
        role: 'ASSISTANT',
        content: 'Sure — let’s track your spending together.',
        createdAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    ],
    skipDuplicates: true,
  });

  await prisma.account.create({
    data: {
      id: SEED_ACCOUNT_ID,
      userId: SEED_USER_ID,
      accountNumber: '0123456789',
      accountType: AccountType.CHECKING,
    },
  });

  await prisma.wallet.create({
    data: { id: SEED_WALLET_ID, accountId: SEED_ACCOUNT_ID, balance: '5000.00', currency: 'NGN' },
  });

  await prisma.transaction.create({
    data: {
      id: SEED_TRANSACTION_ID,
      userId: SEED_USER_ID,
      walletId: SEED_WALLET_ID,
      cardId: SEED_CARD_ID,
      type: 'PAYMENT',
      status: 'PENDING',
      approvalStatus: 'PENDING',
      amount: '2500.00',
      currency: 'NGN',
      description: 'Lunch with Amina',
    },
  });

  await prisma.transactionApproval.create({
    data: {
      id: SEED_APPROVAL_ID,
      transactionId: SEED_TRANSACTION_ID,
      status: 'PENDING',
      approvedBy: SEED_USER_ID,
    },
  });

  await prisma.transactionThreshold.create({
    data: {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      userId: SEED_USER_ID,
      thresholdType: 'FIRST_TIME',
      thresholdValue: '1000.00',
    },
  });

  await prisma.notification.create({
    data: {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      userId: SEED_USER_ID,
      title: 'Welcome to Bonde',
      content: 'Your account is ready.',
      type: 'SYSTEM',
    },
  });

  await prisma.biometricDevice.create({
    data: {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      userId: SEED_USER_ID,
      deviceId: 'device-abc-123',
      deviceName: 'iPhone 15 Pro',
      biometricType: 'FACE',
      publicKey: 'pub-key-1',
    },
  });
}
