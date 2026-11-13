import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { alertSeverity, estimateCost, usageCounts } from './usage-math.js';

const rate = {
  inputPerMillion: new Prisma.Decimal(2),
  cachedInputPerMillion: new Prisma.Decimal('0.5'),
  outputPerMillion: new Prisma.Decimal(8),
  searchPerThousand: new Prisma.Decimal(5),
};
describe('AI usage accounting', () => {
  it('prices cached input separately and never double-counts reasoning tokens', () => {
    const counts = usageCounts({
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 25,
        output_tokens_details: { reasoning_tokens: 10 },
      },
    });
    expect(estimateCost('OPENAI', 'SUCCESS', counts, rate)?.toString()).toBe('0.00034');
  });
  it('retains unknown usage and unknown pricing instead of inventing a free call', () => {
    expect(estimateCost('OPENAI', 'SUCCESS', usageCounts({}), rate)).toBeNull();
    expect(
      estimateCost(
        'OPENAI',
        'SUCCESS',
        usageCounts({ usage: { input_tokens: 10, output_tokens: 5 } }),
        null,
      ),
    ).toBeNull();
    expect(
      usageCounts({
        usage: { input_tokens: 3, input_tokens_details: { cached_tokens: 5 }, output_tokens: -1 },
      }),
    ).toMatchObject({ cachedInputTokens: null, outputTokens: null });
  });
  it('counts a successful Brave request, not the number of returned products', () => {
    expect(estimateCost('BRAVE', 'SUCCESS', usageCounts(null), rate)?.toString()).toBe('0.005');
    expect(estimateCost('BRAVE', 'HTTP_ERROR', usageCounts(null), null)?.toString()).toBe('0');
    expect(estimateCost('BRAVE', 'UNKNOWN', usageCounts(null), rate)).toBeNull();
  });
  it('triggers at exact percentage boundaries and treats overspend as critical', () => {
    const base = new Prisma.Decimal(100);
    expect(alertSeverity(new Prisma.Decimal(21), base, 20, 10)).toBeNull();
    expect(alertSeverity(new Prisma.Decimal(20), base, 20, 10)).toBe('WARNING');
    expect(alertSeverity(new Prisma.Decimal(10), base, 20, 10)).toBe('CRITICAL');
    expect(alertSeverity(new Prisma.Decimal(-1), base, 20, 10)).toBe('CRITICAL');
  });
});
