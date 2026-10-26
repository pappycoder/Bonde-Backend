import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { currencyOf } from './finance.types.js';

export interface Posting {
  key: string;
  currency: string;
  amount: Prisma.Decimal;
  userId?: string;
  kind: string;
}
@Injectable()
export class LedgerService {
  /** Caller owns the transaction. Journals and cached account balances commit together. */
  async post(
    tx: Prisma.TransactionClient,
    reference: string,
    description: string,
    lines: Posting[],
  ) {
    const sums = new Map<string, Prisma.Decimal>();
    const merged = new Map<string, Posting>();
    for (const line of lines) {
      currencyOf(line.currency);
      if (!line.amount.isFinite() || line.amount.decimalPlaces() > 2)
        throw new BadRequestException('Invalid posting');
      sums.set(line.currency, (sums.get(line.currency) ?? new Prisma.Decimal(0)).add(line.amount));
      const existing = merged.get(line.key);
      if (existing && (existing.currency !== line.currency || existing.userId !== line.userId))
        throw new BadRequestException('Account mismatch');
      merged.set(line.key, {
        ...line,
        amount: (existing?.amount ?? new Prisma.Decimal(0)).add(line.amount),
      });
    }
    if (lines.length < 2 || [...sums.values()].some((sum) => !sum.isZero()))
      throw new BadRequestException('Unbalanced journal');
    const journal = await tx.financeJournal.create({
      data: { id: randomUUID(), reference, description },
    });
    // Deterministic lock order prevents cross-account transfer deadlocks.
    for (const line of [...merged.values()].sort((a, b) => a.key.localeCompare(b.key))) {
      await tx.financeAccount.upsert({
        where: { key: line.key },
        create: {
          key: line.key,
          currency: line.currency,
          kind: line.kind,
          userId: line.userId,
        },
        update: {},
      });
      const changed = await tx.financeAccount.updateMany({
        where: {
          key: line.key,
          currency: line.currency,
          userId: line.userId ?? null,
          kind: line.kind,
          ...(line.userId && line.amount.lt(0) ? { balance: { gte: line.amount.negated() } } : {}),
        },
        data: { balance: { increment: line.amount } },
      });
      if (!changed.count) throw new BadRequestException('Insufficient available funds');
      await tx.financeEntry.create({
        data: {
          id: randomUUID(),
          journalId: journal.id,
          accountKey: line.key,
          amount: line.amount,
        },
      });
    }
    return journal;
  }
}
