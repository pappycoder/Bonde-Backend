import { Prisma } from '@prisma/client';

export type MoneyValue = Prisma.Decimal | string | number;

/**
 * Canonical money serialization across the API: a Decimal money value as a
 * fixed 2-decimal string (`2500.00`). Plain numeric strings are normalized the
 * same way, so read models and DTOs stay consistent regardless of source.
 */
export function money(value: MoneyValue): string {
  return new Prisma.Decimal(value).toFixed(2);
}
