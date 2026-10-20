import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

export const DEMO_SEED = 'bonde.transaction-ui.v1';

export function demoId(userId, key) {
  const bytes = createHash('sha256').update(`${DEMO_SEED}:${userId}:${key}`).digest();
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function demoTransactions(userId, walletId, now = new Date()) {
  const anchor = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 14, 30),
  );
  const dateAt = (days) => new Date(anchor.getTime() - days * 86_400_000);
  const dateLabel = (date) =>
    new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  const started = dateAt(2);
  const renewal = new Date(started);
  renewal.setUTCMonth(renewal.getUTCMonth() + 1);
  // key, description, type, amount, age in days, metadata, status, approval, currency
  const examples = [
    [
      'payment-reversal',
      'Payment reversal',
      'DEPOSIT',
      '75.00',
      0,
      {
        transactionType: 'PAYMENT_REVERSAL',
        merchant: 'Demo Example Store',
        originalTransactionId: demoId(userId, 'original-card-payment'),
        originalAmount: '75.00',
        reason: 'Demo reversed payment',
        destination: 'BONDE Wallet',
      },
      'SUCCESS',
      'APPROVED',
      'USD',
    ],
    [
      'premium',
      'BONDE Premium monthly subscription',
      'PAYMENT',
      '15000.00',
      2,
      {
        transactionType: 'PREMIUM_SUBSCRIPTION',
        serviceProvider: 'BONDE',
        plan: 'Premium',
        billingFrequency: 'Monthly',
        planPrice: '15000.00',
        tax: '0.00',
        subscriptionStartDate: dateLabel(started),
        nextBillingDate: dateLabel(renewal),
      },
    ],
    [
      'ai-purchase',
      'AI Credits Starter Pack',
      'PAYMENT',
      '5000.00',
      3,
      {
        transactionType: 'AI_CREDIT_PURCHASE',
        package: 'Starter Pack',
        creditsPurchased: '500 credits',
        bonusCredits: '50 credits',
        totalCredits: '550 credits',
        packagePrice: '5000.00',
        paymentMethod: 'BONDE Wallet',
      },
    ],
    [
      'ai-refund',
      'AI credit refund',
      'DEPOSIT',
      '5000.00',
      1,
      {
        transactionType: 'AI_CREDIT_REFUND',
        package: 'Starter Pack',
        originalTransactionId: demoId(userId, 'ai-purchase'),
        originalAmount: '5000.00',
        destination: 'BONDE Wallet',
        creditAdjustment: '550 demo credits removed',
      },
    ],
    [
      'deposit-success',
      'Wallet funding',
      'DEPOSIT',
      '120000.00',
      1,
      { paymentMethod: 'Bank transfer' },
    ],
    [
      'deposit-pending',
      'Pending wallet funding',
      'DEPOSIT',
      '25000.00',
      0,
      { paymentMethod: 'Bank transfer' },
      'PENDING',
      'APPROVED',
    ],
    [
      'deposit-failed',
      'Failed wallet funding',
      'DEPOSIT',
      '10000.00',
      4,
      { reason: 'Demo transfer expired' },
      'FAIL',
      'APPROVED',
    ],
    [
      'withdraw-success',
      'Bank withdrawal',
      'WITHDRAWAL',
      '20000.00',
      2,
      { bankName: 'Demo Bank', accountName: 'Demo recipient', paymentMethod: 'BONDE Wallet' },
    ],
    [
      'withdraw-pending',
      'Pending bank withdrawal',
      'WITHDRAWAL',
      '7500.00',
      0,
      { bankName: 'Demo Bank', accountName: 'Demo recipient' },
      'PENDING',
      'APPROVED',
    ],
    [
      'withdraw-failed',
      'Failed bank withdrawal',
      'WITHDRAWAL',
      '3000.00',
      5,
      { reason: 'Demo recipient bank unavailable' },
      'FAIL',
      'APPROVED',
    ],
    [
      'shopping',
      'Demo Store headphones',
      'PAYMENT',
      '35000.00',
      1,
      {
        merchant: 'Demo Store',
        item: 'Wireless headphones',
        walletCategory: 'SHOPPING',
        paymentMethod: 'Agent Card',
      },
    ],
    [
      'shopping-pending',
      'Demo Store pending order',
      'PAYMENT',
      '6500.00',
      1,
      { merchant: 'Demo Store', walletCategory: 'SHOPPING' },
      'PENDING',
      'APPROVED',
    ],
    [
      'shopping-failed',
      'Demo Store failed order',
      'PAYMENT',
      '8500.00',
      6,
      {
        merchant: 'Demo Store',
        walletCategory: 'SHOPPING',
        reason: 'Demo payment declined by provider',
      },
      'FAIL',
      'APPROVED',
    ],
    [
      'shopping-declined',
      'Demo Store declined approval',
      'PAYMENT',
      '45000.00',
      4,
      { merchant: 'Demo Store', walletCategory: 'SHOPPING' },
      'PENDING',
      'DECLINED',
    ],
    [
      'approval-pending',
      'Demo purchase awaiting approval',
      'PAYMENT',
      '9000.00',
      0,
      { merchant: 'Demo Store', walletCategory: 'SHOPPING' },
      'PENDING',
      'PENDING',
    ],
    [
      'transport',
      'Demo city ride',
      'PAYMENT',
      '4200.00',
      3,
      { merchant: 'Demo Transport', walletCategory: 'TRAVEL' },
    ],
    [
      'utilities',
      'Demo electricity bill',
      'PAYMENT',
      '12000.00',
      5,
      { merchant: 'Demo Electricity', walletCategory: 'ELECTRICITY' },
    ],
    [
      'dining',
      'Demo restaurant lunch',
      'PAYMENT',
      '7800.00',
      7,
      { merchant: 'Demo Restaurant', walletCategory: 'DINING' },
    ],
    [
      'health',
      'Demo pharmacy',
      'PAYMENT',
      '5500.00',
      8,
      { merchant: 'Demo Pharmacy', walletCategory: 'HEALTH' },
    ],
    [
      'groceries',
      'Demo supermarket groceries',
      'PAYMENT',
      '18500.00',
      10,
      { merchant: 'Demo Supermarket', walletCategory: 'GROCERIES' },
    ],
    [
      'transfer',
      'Demo outgoing transfer',
      'TRANSFER',
      '15000.00',
      12,
      { accountName: 'Demo recipient', paymentMethod: 'BONDE Wallet' },
    ],
    [
      'original-card-payment',
      'Demo Example Store original payment',
      'PAYMENT',
      '75.00',
      14,
      { merchant: 'Demo Example Store', item: 'Demo purchase', walletCategory: 'SHOPPING' },
      'SUCCESS',
      'APPROVED',
      'USD',
    ],
    [
      'older-groceries',
      'Demo previous month groceries',
      'PAYMENT',
      '22000.00',
      32,
      { merchant: 'Demo Supermarket', walletCategory: 'GROCERIES' },
    ],
    [
      'older-transport',
      'Demo previous month transport',
      'PAYMENT',
      '3800.00',
      40,
      { merchant: 'Demo Transport', walletCategory: 'TRAVEL' },
    ],
    [
      'older-deposit',
      'Demo earlier wallet funding',
      'DEPOSIT',
      '80000.00',
      48,
      { paymentMethod: 'Bank transfer' },
    ],
    [
      'older-dining',
      'Demo earlier restaurant visit',
      'PAYMENT',
      '6300.00',
      62,
      { merchant: 'Demo Restaurant', walletCategory: 'DINING' },
    ],
  ];
  return examples.map(
    (
      [
        key,
        description,
        type,
        amount,
        age,
        metadata,
        status = 'SUCCESS',
        approvalStatus = 'APPROVED',
        currency = 'NGN',
      ],
      index,
    ) => ({
      id: demoId(userId, key),
      userId,
      walletId,
      type,
      status,
      approvalStatus,
      amount,
      currency,
      description: `[DEMO] ${description}`,
      metadata: { ...metadata, demo: true, demoSeed: DEMO_SEED, demoKey: key },
      createdAt: new Date(dateAt(age).getTime() - index * 60_000),
    }),
  );
}

export function demoWhere(userId) {
  return { userId, metadata: { path: ['demoSeed'], equals: DEMO_SEED } };
}

export async function seedDemoTransactions(
  prisma,
  { email, apply = false, remove = false, now = new Date() },
) {
  const profile = await prisma.profile.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { id: true, email: true, accounts: { select: { wallets: { select: { id: true } } } } },
  });
  if (!profile) throw new Error('Test account not found. No records were changed.');
  const wallets = profile.accounts.flatMap((account) => account.wallets);
  if (wallets.length !== 1)
    throw new Error('Expected one existing wallet. No records were changed.');
  const records = demoTransactions(profile.id, wallets[0].id, now);
  const where = { ...demoWhere(profile.id), id: { in: records.map((row) => row.id) } };
  const existing = await prisma.transaction.count({ where });
  if (!apply)
    return {
      mode: 'preview',
      email: profile.email,
      operation: remove ? 'remove' : 'create',
      existing,
      planned: remove ? existing : records.length - existing,
    };
  const result = remove
    ? await prisma.transaction.deleteMany({ where })
    : await prisma.transaction.createMany({ data: records, skipDuplicates: true });
  return {
    mode: 'applied',
    email: profile.email,
    operation: remove ? 'removed' : 'created',
    count: result.count,
    totalDemoRecords: await prisma.transaction.count({ where }),
    balanceModified: false,
  };
}

async function main() {
  dotenv.config({ quiet: true });
  if (process.env.NODE_ENV === 'production')
    throw new Error('Demo seeding is disabled in production.');
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  const allowed = new Set(['--email', '--date', '--apply', '--remove']);
  let email,
    now = new Date();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!allowed.has(arg)) throw new Error(`Unknown argument: ${arg}`);
    if (arg === '--email' || arg === '--date') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--email') email = value;
      else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Date must be YYYY-MM-DD.');
        now = new Date(`${value}T12:00:00Z`);
        if (!Number.isFinite(now.getTime()) || now.toISOString().slice(0, 10) !== value)
          throw new Error('Invalid date.');
      }
    }
  }
  if (!email?.includes('@')) throw new Error('Pass --email for the existing test account.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 10000,
    }),
  });
  try {
    console.log(
      JSON.stringify(
        await seedDemoTransactions(prisma, {
          email,
          now,
          apply: args.includes('--apply'),
          remove: args.includes('--remove'),
        }),
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Avoid printing connection strings or driver internals on connection errors.
    console.error(
      error.constructor === Error
        ? error.message
        : `Demo seed failed (${error.code ?? error.name}).`,
    );
    process.exitCode = 1;
  });
}
