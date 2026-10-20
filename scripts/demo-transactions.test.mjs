import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_SEED, demoTransactions, seedDemoTransactions } from './demo-transactions.mjs';

const now = new Date('2026-10-20T12:00:00Z');
const userId = '11111111-1111-4111-8111-111111111111';
const walletId = '77777777-7777-4777-8777-777777777777';

function fakeDatabase({ found = true, walletCount = 1 } = {}) {
  const rows = [];
  const matches = (row, where) =>
    row.userId === where.userId &&
    row.metadata.demoSeed === where.metadata.equals &&
    where.id.in.includes(row.id);
  let creates = 0;
  let deletes = 0;
  const prisma = {
    profile: {
      findUnique: async ({ where }) =>
        found
          ? {
              id: userId,
              email: where.email,
              accounts: [
                {
                  wallets: Array.from({ length: walletCount }, (_, index) => ({
                    id: index === 0 ? walletId : `other-${index}`,
                  })),
                },
              ],
            }
          : null,
    },
    transaction: {
      count: async ({ where }) => rows.filter((row) => matches(row, where)).length,
      createMany: async ({ data, skipDuplicates }) => {
        assert.equal(skipDuplicates, true);
        creates++;
        const additions = data.filter((row) => !rows.some((current) => current.id === row.id));
        rows.push(...additions);
        return { count: additions.length };
      },
      deleteMany: async ({ where }) => {
        deletes++;
        const removed = rows.filter((row) => matches(row, where));
        for (const row of removed) rows.splice(rows.indexOf(row), 1);
        return { count: removed.length };
      },
    },
  };
  return {
    prisma,
    rows,
    get creates() {
      return creates;
    },
    get deletes() {
      return deletes;
    },
  };
}

test('demo fixtures cover pagination, all effective statuses, categories and extended layouts', () => {
  const rows = demoTransactions(userId, walletId, now);
  assert.equal(rows.length, 26);
  assert.equal(new Set(rows.map((row) => row.id)).size, 26);
  for (const row of rows) {
    assert.match(row.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(row.userId, userId);
    assert.equal(row.walletId, walletId);
    assert.equal(row.metadata.demoSeed, DEMO_SEED);
    assert.ok(row.description.startsWith('[DEMO]'));
    assert.match(row.amount, /^\d+\.\d{2}$/);
    assert.ok(row.createdAt <= now || row.createdAt.toISOString().startsWith('2026-10-20'));
    assert.equal(row.cardId, undefined);
    assert.equal(row.chatId, undefined);
  }
  assert.deepEqual(new Set(rows.map((row) => row.status)), new Set(['SUCCESS', 'PENDING', 'FAIL']));
  assert.ok(rows.some((row) => row.approvalStatus === 'DECLINED'));
  for (const category of ['TRAVEL', 'ELECTRICITY', 'DINING', 'HEALTH', 'SHOPPING', 'GROCERIES'])
    assert.ok(rows.some((row) => row.metadata.walletCategory === category));
  for (const kind of [
    'PAYMENT_REVERSAL',
    'PREMIUM_SUBSCRIPTION',
    'AI_CREDIT_PURCHASE',
    'AI_CREDIT_REFUND',
  ])
    assert.ok(rows.some((row) => row.metadata.transactionType === kind));
  for (const row of rows.filter((row) => row.metadata.originalTransactionId)) {
    const original = rows.find((original) => original.id === row.metadata.originalTransactionId);
    assert.ok(original);
    assert.equal(original.currency, row.currency);
    assert.equal(original.amount, row.metadata.originalAmount);
  }
  assert.ok(rows.some((row) => row.createdAt < new Date('2026-09-01')));
});

test('preview makes no writes and repeated apply is idempotent', async () => {
  const db = fakeDatabase();
  const options = { email: ' Test@Example.com ', now };
  const preview = await seedDemoTransactions(db.prisma, options);
  assert.equal(preview.email, 'test@example.com');
  assert.equal(preview.planned, 26);
  assert.equal(db.creates, 0);
  assert.equal((await seedDemoTransactions(db.prisma, { ...options, apply: true })).count, 26);
  const again = await seedDemoTransactions(db.prisma, { ...options, apply: true });
  assert.equal(again.count, 0);
  assert.equal(again.totalDemoRecords, 26);
  assert.equal(again.balanceModified, false);
});

test('cleanup is scoped to this owner, marker and deterministic fixture IDs', async () => {
  const db = fakeDatabase();
  const options = { email: 'test@example.com', now, apply: true };
  await seedDemoTransactions(db.prisma, options);
  const record = db.rows[0];
  db.rows.push({ ...record, id: 'real-transaction', metadata: {} });
  db.rows.push({ ...record, userId: 'other-owner' });
  db.rows.push({ ...record, id: 'unrelated-demo', metadata: { demoSeed: DEMO_SEED } });
  const preview = await seedDemoTransactions(db.prisma, { ...options, apply: false, remove: true });
  assert.equal(preview.planned, 26);
  assert.equal(db.deletes, 0);
  assert.equal((await seedDemoTransactions(db.prisma, { ...options, remove: true })).count, 26);
  assert.equal(db.rows.length, 3);
  assert.equal(db.rows[0].id, 'real-transaction');
});

test('unknown accounts and missing/ambiguous wallets cannot be seeded', async () => {
  for (const option of [{ found: false }, { walletCount: 0 }, { walletCount: 2 }]) {
    const db = fakeDatabase(option);
    await assert.rejects(
      seedDemoTransactions(db.prisma, { email: 'missing@example.com', apply: true, now }),
    );
    assert.equal(db.creates, 0);
  }
});
