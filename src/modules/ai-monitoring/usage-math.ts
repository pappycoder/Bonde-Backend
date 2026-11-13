import { Prisma } from '@prisma/client';

export const AI_PROVIDERS = ['OPENAI', 'BRAVE'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export interface UsageCounts {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
}
export interface UsagePrices {
  inputPerMillion: Prisma.Decimal;
  cachedInputPerMillion: Prisma.Decimal;
  outputPerMillion: Prisma.Decimal;
  searchPerThousand: Prisma.Decimal;
}
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647
    ? value
    : null;

export function usageCounts(body: unknown): UsageCounts {
  const usage = obj(obj(body).usage);
  const inputTokens = count(usage.input_tokens);
  const outputTokens = count(usage.output_tokens);
  const cached = count(obj(usage.input_tokens_details).cached_tokens ?? 0);
  const reasoning = count(obj(usage.output_tokens_details).reasoning_tokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens:
      inputTokens !== null && cached !== null && cached <= inputTokens ? cached : null,
    reasoningTokens:
      outputTokens !== null && reasoning !== null && reasoning <= outputTokens ? reasoning : null,
  };
}

export function estimateCost(
  provider: AiProvider,
  status: string,
  counts: UsageCounts,
  rate: UsagePrices | null,
) {
  if (provider === 'BRAVE' && status === 'HTTP_ERROR') return new Prisma.Decimal(0);
  if (!rate || status === 'UNKNOWN' || status === 'PENDING') return null;
  if (provider === 'BRAVE') return rate.searchPerThousand.div(1000);
  const { inputTokens, cachedInputTokens, outputTokens } = counts;
  if (inputTokens === null || cachedInputTokens === null || outputTokens === null) return null;
  // Cached tokens are a subset of input; reasoning tokens are a subset of output.
  return rate.inputPerMillion
    .mul(inputTokens - cachedInputTokens)
    .add(rate.cachedInputPerMillion.mul(cachedInputTokens))
    .add(rate.outputPerMillion.mul(outputTokens))
    .div(1000000)
    .toDecimalPlaces(10);
}

export function alertSeverity(
  remaining: Prisma.Decimal,
  base: Prisma.Decimal,
  warning: number,
  critical: number,
) {
  if (remaining.lte(base.mul(critical).div(100))) return 'CRITICAL';
  if (remaining.lte(base.mul(warning).div(100))) return 'WARNING';
  return null;
}
