import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, timingSafeEqual } from 'node:crypto';

export type Currency = 'NGN' | 'USD';
export const currencies: Currency[] = ['NGN', 'USD'];
export function currencyOf(value: string): Currency {
  if (!currencies.includes(value as Currency))
    throw new BadRequestException('Unsupported currency');
  return value as Currency;
}
export function amountOf(value: string, allowZero = false): Prisma.Decimal {
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(value)) throw new BadRequestException('Invalid amount');
  const amount = new Prisma.Decimal(value);
  if (allowZero ? amount.lt(0) : amount.lte(0)) throw new BadRequestException('Invalid amount');
  return amount;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}
export const walletKey = (userId: string, currency: string) => `wallet:${userId}:${currency}`;
export const cardKey = (cardId: string, currency: string) => `card:${cardId}:${currency}`;
export const holdKey = (reference: string, currency: string) => `hold:${reference}:${currency}`;
export const systemKey = (kind: string, currency: string) => `system:${kind}:${currency}`;
