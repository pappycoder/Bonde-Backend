import { BadRequestException } from '@nestjs/common';
import type { FinanceConfig } from './finance.config.js';

export const cardBrands = ['Verve', 'AfriGo', 'MasterCard', 'Visa'] as const;
export type CardBrand = (typeof cardBrands)[number];
export interface CardProgramme {
  brand: CardBrand;
  issueFee: string;
  fundingSourceId: string;
  settlementId: string;
}

/** Explicit entries are operator-confirmed programmes, not a provider entitlement lookup. */
export function parseCardProgrammes(raw: string | undefined): CardProgramme[] | undefined {
  if (!raw?.trim()) return undefined;
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows) || !rows.length) throw new Error('Expected a nonempty programme array');
  const seen = new Set<string>();
  return rows.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new Error('Invalid card programme');
    const p = row as Record<string, unknown>;
    if (
      Object.keys(p).some(
        (key) => !['brand', 'issueFee', 'fundingSourceId', 'settlementId'].includes(key),
      ) ||
      !cardBrands.includes(p.brand as CardBrand) ||
      seen.has(String(p.brand)) ||
      typeof p.issueFee !== 'string' ||
      !/^\d{1,12}(\.\d{1,2})?$/.test(p.issueFee) ||
      typeof p.fundingSourceId !== 'string' ||
      !p.fundingSourceId.trim() ||
      typeof p.settlementId !== 'string' ||
      !p.settlementId.trim()
    )
      throw new Error('Invalid or duplicate card programme');
    seen.add(String(p.brand));
    const [whole, fraction = ''] = p.issueFee.split('.');
    return {
      brand: p.brand as CardBrand,
      issueFee: `${BigInt(whole)}.${fraction.padEnd(2, '0')}`,
      fundingSourceId: p.fundingSourceId.trim(),
      settlementId: p.settlementId.trim(),
    };
  });
}

export function cardProgrammes(c: FinanceConfig, currency: string): CardProgramme[] {
  if (currency === 'NGN' && c.ngnCardProgrammes) return c.ngnCardProgrammes;
  return [
    {
      brand: (currency === 'NGN' ? c.ngnBrand : c.usdBrand) as CardBrand,
      issueFee: currency === 'NGN' ? c.ngnIssueFee : c.usdIssueFee,
      fundingSourceId: currency === 'NGN' ? c.ngnFundingSourceId : c.usdFundingSourceId,
      settlementId: currency === 'NGN' ? c.ngnSettlementId : c.usdSettlementId,
    },
  ];
}

export function selectCardProgramme(
  c: FinanceConfig,
  currency: string,
  brand?: string,
): CardProgramme {
  const programmes = cardProgrammes(c, currency);
  const defaultBrand = currency === 'NGN' ? c.ngnBrand : c.usdBrand;
  const programme =
    brand === undefined
      ? (programmes.find((p) => p.brand === defaultBrand) ?? programmes[0])
      : programmes.find((p) => p.brand === brand);
  if (!programme)
    throw new BadRequestException('This card brand is not available for this currency');
  return programme;
}
