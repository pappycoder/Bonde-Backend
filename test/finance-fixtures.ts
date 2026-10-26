import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { FinanceCapabilities } from '../src/modules/finance/finance-capabilities.service.js';
import { LedgerService } from '../src/modules/finance/ledger.service.js';
import { PasscodeService } from '../src/modules/passcode/passcode.service.js';
import {
  bootE2EApp,
  SEED_USER_ID,
  SEED_CARD_ID,
  type BootE2EOptions,
  type BootedE2EApp,
} from './e2e-app.js';

/** Isolate counters without disabling rate limiting in the app under test. */
export function financeTestEnvironment(redisDb: number) {
  const changes = {
    REDIS_URL: `redis://localhost:6379/${redisDb}`,
    THROTTLE_STRICT_LIMIT: '1000',
    THROTTLE_STRICT_TTL: '60000',
    THROTTLE_STRICT_BLOCK_DURATION: '60000',
  };
  const original = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  return () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export function bootFinanceE2EApp(options: BootE2EOptions = {}) {
  return bootE2EApp({
    overrides: [
      {
        token: FinanceCapabilities,
        useValue: {
          enabled: true,
          assertEnabled() {},
          assertCurrency(currency: string) {
            if (currency !== 'NGN') throw new Error('Test programme only supports NGN');
          },
          view: () => ({ enabled: true, currencies: { NGN: { enabled: true } } }),
        },
      },
      ...(options.overrides ?? []),
    ],
  });
}

/** Seed real ledger funds; the historical Wallet.balance column is never money. */
export async function seedFinanceFunds(ctx: BootedE2EApp, amount = '100.00') {
  await ctx.app.get(PasscodeService).create(SEED_USER_ID, '1234');
  await ctx.prisma.card.update({
    where: { id: SEED_CARD_ID },
    data: {
      issuer: 'sudo',
      externalReferenceId: 'provider-card',
      status: 'ACTIVE',
      currency: 'NGN',
      expirationDate: new Date('2030-01-01'),
    },
  });
  await ctx.prisma.$transaction((tx) =>
    ctx.app.get(LedgerService).post(tx, 'test:deposit', 'Verified test deposit', [
      {
        key: `wallet:${SEED_USER_ID}:NGN`,
        userId: SEED_USER_ID,
        kind: 'WALLET',
        currency: 'NGN',
        amount: new Prisma.Decimal(amount),
      },
      {
        key: 'system:test:NGN',
        kind: 'TEST',
        currency: 'NGN',
        amount: new Prisma.Decimal(amount).negated(),
      },
    ]),
  );
}
export async function executeFinance(
  ctx: BootedE2EApp,
  fields: Record<string, unknown>,
  key = randomUUID(),
) {
  const command = { currency: 'NGN', amount: '0.00', fee: '0.00', ...fields };
  const proof = await ctx.http
    .post('/finance/proof')
    .send({ command, passcode: '1234' })
    .expect(201);
  return ctx.http
    .post('/finance/operations')
    .set('Idempotency-Key', key)
    .send({ command, proof: proof.body.proof });
}
