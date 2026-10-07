import { describe, expect, it } from 'vitest';
import { hmacSha256 } from './hmac-sha256.js';

describe('hmacSha256', () => {
  it('is deterministic for the same value + secret', () => {
    expect(hmacSha256('12345678901', 'secret')).toBe(hmacSha256('12345678901', 'secret'));
  });

  it('changes with the secret (peppered, not a bare digest)', () => {
    expect(hmacSha256('12345678901', 'a')).not.toBe(hmacSha256('12345678901', 'b'));
  });

  it('changes with the value', () => {
    expect(hmacSha256('12345678901', 's')).not.toBe(hmacSha256('12345678902', 's'));
  });

  it('produces a 64-char hex digest', () => {
    expect(hmacSha256('12345678901', 'secret')).toMatch(/^[0-9a-f]{64}$/);
  });
});
