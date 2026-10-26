import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  bootE2EApp,
  SEED_USER_ID,
  SEED_CARD_ID,
  seedBaseFixtures,
  truncateAll,
  type BootedE2EApp,
} from './e2e-app.js';
import { LedgerService } from '../src/modules/finance/ledger.service.js';
import { FinanceCapabilities } from '../src/modules/finance/finance-capabilities.service.js';
import { PasscodeService } from '../src/modules/passcode/passcode.service.js';

describe('Existing screens through canonical finance commands', () => {
  let ctx: BootedE2EApp;
  const capabilities = {
    enabled: true,
    assertEnabled: vi.fn(),
    assertCurrency: vi.fn(),
    view: () => ({ enabled: true, currencies: { NGN: { enabled: true } } }),
  };
  beforeEach(async () => {
    ctx = await bootE2EApp({ overrides: [{ token: FinanceCapabilities, useValue: capabilities }] });
    await truncateAll(ctx.prisma);
    await seedBaseFixtures(ctx.prisma);
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
          amount: new Prisma.Decimal(100),
        },
        { key: 'system:test:NGN', kind: 'TEST', currency: 'NGN', amount: new Prisma.Decimal(-100) },
      ]),
    );
  });
  afterEach(async () => {
    await ctx.close();
  });
  const command = (kind = 'ALLOCATE', amount = '25.00') => ({
    kind,
    currency: 'NGN',
    amount,
    fee: '0.00',
    cardId: SEED_CARD_ID,
  });
  async function execute(body: object, key: string) {
    const proof = await ctx.http
      .post('/finance/proof')
      .send({ command: body, passcode: '1234' })
      .expect(201);
    return ctx.http
      .post('/finance/operations')
      .set('Idempotency-Key', key)
      .send({ command: body, proof: proof.body.proof });
  }
  it('allocates and returns money while existing wallet/card screens read the same ledger', async () => {
    const result = await execute(command(), 'allocate-key-123456789');
    expect(result.status).toBe(201);
    expect(result.body.status).toBe('SUCCEEDED');
    expect((await ctx.http.get('/wallet').expect(200)).body).toMatchObject({
      balance: '75.00',
      allocated: '25.00',
    });
    expect((await ctx.http.get(`/cards/${SEED_CARD_ID}`).expect(200)).body.balance).toBe('25.00');
    expect((await execute(command('RETURN', '10.00'), 'return-key-123456789')).body.status).toBe(
      'SUCCEEDED',
    );
    expect((await ctx.http.get('/wallet').expect(200)).body).toMatchObject({
      balance: '85.00',
      allocated: '15.00',
    });
  });
  it('allows the initial allocation with top-ups disabled and rejects any later allocation', async () => {
    await ctx.prisma.card.update({
      where: { id: SEED_CARD_ID },
      data: { allowTopUp: false, externalReferenceId: 'provider-card' },
    });
    expect((await execute(command(), 'first-allocation-key-123456')).body.status).toBe('SUCCEEDED');
    const second = await execute(command(), 'second-allocation-key-123456');
    expect(second.status).toBe(400);
    expect((await ctx.http.get('/wallet').expect(200)).body.balance).toBe('75.00');
  });

  it('replays the original operation without a second debit', async () => {
    const key = 'replay-key-123456789';
    const first = await execute(command(), key);
    const second = await execute(command(), key);
    expect(second.body.id).toBe(first.body.id);
    expect((await ctx.http.get('/wallet').expect(200)).body.balance).toBe('75.00');
  });
  it('rejects a command changed after passcode confirmation', async () => {
    const proof = await ctx.http
      .post('/finance/proof')
      .send({ command: command(), passcode: '1234' })
      .expect(201);
    await ctx.http
      .post('/finance/operations')
      .set('Idempotency-Key', 'tampered-key-123456789')
      .send({ command: command('ALLOCATE', '26.00'), proof: proof.body.proof })
      .expect(401);
    expect((await ctx.http.get('/wallet').expect(200)).body.balance).toBe('100.00');
  });
});
