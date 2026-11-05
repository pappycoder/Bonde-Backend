import { describe, expect, it } from 'vitest';
import { serviceOutcome } from './vtpass.client.js';
describe('VTpass confirmation semantics', () => {
  it('requires an authoritative delivered status, not HTTP 200 or a processed code', () => {
    expect(
      serviceOutcome({ code: '000', content: { transactions: { status: 'delivered' } } }),
    ).toBe('SUCCEEDED');
    for (const code of ['000', '099', '014', '015', '019', '044', 'unknown'])
      expect(serviceOutcome({ code })).toBe('PENDING');
    expect(serviceOutcome({ code: '000', content: { transactions: { status: 'pending' } } })).toBe(
      'PENDING',
    );
    expect(serviceOutcome({ code: '016' })).toBe('FAILED');
  });
});
