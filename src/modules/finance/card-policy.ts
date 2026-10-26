import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

// MCCs are scheme identifiers, never merchant display-name substring matches.
export const categoryMccs: Record<string, string[]> = {
  TRAVEL_HOTEL: ['7011', '4511', '4722'],
  TRAVEL: ['4511', '4722', '4111', '4121'],
  FOOD_RESTAURANT: ['5812', '5814'],
  DINING: ['5812', '5814'],
  GROCERIES: ['5411'],
  ENTERTAINMENT: ['7832', '7922', '7996', '7999'],
  SHOPPING: ['5311', '5399', '5699'],
  ELECTRICITY: ['4900'],
};
export interface CardRules {
  type?: 'SELF_DESTRUCT' | 'MERCHANT' | 'TIME' | 'CATEGORY' | 'BUDGET';
  maxSpendLimit?: string;
  monthlyLimit?: string;
  usageLimit?: number;
  start?: string;
  end?: string;
  merchantIds?: string[];
  categories?: string[];
  allowTopUp?: boolean;
}
export function validateRules(raw: Record<string, unknown> = {}): CardRules {
  const keys = [
    'type',
    'maxSpendLimit',
    'monthlyLimit',
    'usageLimit',
    'start',
    'end',
    'merchantIds',
    'categories',
    'allowTopUp',
  ];
  if (Object.keys(raw).some((k) => !keys.includes(k)))
    throw new BadRequestException('Unsupported rule field');
  const rule = raw as CardRules;
  if (rule.type && !['SELF_DESTRUCT', 'MERCHANT', 'TIME', 'CATEGORY', 'BUDGET'].includes(rule.type))
    throw new BadRequestException('Unsupported rule');
  for (const value of [rule.maxSpendLimit, rule.monthlyLimit])
    if (
      value !== undefined &&
      (typeof value !== 'string' ||
        !/^\d{1,12}(\.\d{1,2})?$/.test(value) ||
        new Prisma.Decimal(value).lte(0))
    )
      throw new BadRequestException('Invalid spending limit');
  if (
    rule.type === 'SELF_DESTRUCT' &&
    (!Number.isSafeInteger(rule.usageLimit) || rule.usageLimit! < 1)
  )
    throw new BadRequestException('Invalid usage limit');
  if (
    rule.type === 'TIME' &&
    (!rule.start ||
      !rule.end ||
      !Number.isFinite(Date.parse(rule.start)) ||
      !Number.isFinite(Date.parse(rule.end)) ||
      Date.parse(rule.end) <= Date.parse(rule.start))
  )
    throw new BadRequestException('Invalid time window');
  if (
    rule.type === 'MERCHANT' &&
    (!Array.isArray(rule.merchantIds) ||
      !rule.merchantIds.length ||
      rule.merchantIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 100))
  )
    throw new BadRequestException('Verified merchant identifiers are required');
  if (
    rule.type === 'CATEGORY' &&
    (!Array.isArray(rule.categories) ||
      !rule.categories.length ||
      rule.categories.some((category) => !categoryMccs[category]))
  )
    throw new BadRequestException('Unsupported category');
  if (rule.type === 'BUDGET' && !rule.monthlyLimit)
    throw new BadRequestException('Monthly budget is required');
  if (rule.allowTopUp !== undefined && typeof rule.allowTopUp !== 'boolean')
    throw new BadRequestException('Invalid top-up preference');
  return rule;
}
export function policyDecision(
  rule: CardRules,
  request: { amount: Prisma.Decimal; merchantId: string; mcc: string },
  usage: { spent: Prisma.Decimal; uses: number },
  now = new Date(),
): string | null {
  if (rule.maxSpendLimit && request.amount.gt(rule.maxSpendLimit)) return 'PER_TRANSACTION_LIMIT';
  if (rule.monthlyLimit && usage.spent.add(request.amount).gt(rule.monthlyLimit))
    return 'MONTHLY_LIMIT';
  if (rule.type === 'SELF_DESTRUCT' && usage.uses >= rule.usageLimit!) return 'USAGE_LIMIT';
  if (rule.type === 'TIME' && (now < new Date(rule.start!) || now >= new Date(rule.end!)))
    return 'TIME_WINDOW';
  if (rule.type === 'MERCHANT' && !rule.merchantIds?.includes(request.merchantId))
    return 'MERCHANT_NOT_ALLOWED';
  if (
    rule.type === 'CATEGORY' &&
    !rule.categories?.some((c) => categoryMccs[c]?.includes(request.mcc))
  )
    return 'CATEGORY_NOT_ALLOWED';
  return null;
}
