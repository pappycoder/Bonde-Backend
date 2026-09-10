import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './aes-gcm.js';
import { generateLuhnPan, last4 } from '../../modules/cards/card-number.js';
import { luhnCheckDigit } from '../../modules/accounts/account-number.js';

const KEY = 'c'.repeat(64);

describe('aes-gcm', () => {
  it('round-trips plaintext', () => {
    const payload = encrypt('4111111111111111', KEY);
    expect(payload).toMatch(/^enc::/);
    expect(decrypt(payload, KEY)).toBe('4111111111111111');
  });

  it('uses a fresh IV per encryption', () => {
    expect(encrypt('hello', KEY)).not.toBe(encrypt('hello', KEY));
  });

  it('rejects a non-32-byte key', () => {
    expect(() => encrypt('hello', 'ab')).toThrow();
  });

  it('rejects a malformed payload', () => {
    expect(() => decrypt('not-encrypted', KEY)).toThrow();
  });
});

describe('card-number', () => {
  it('generates a 16-digit, Luhn-valid PAN starting with 4', () => {
    const pan = generateLuhnPan();
    expect(pan).toMatch(/^4\d{15}$/);
    const digits = Array.from(pan, Number);
    expect(luhnCheckDigit(digits.slice(0, -1))).toBe(digits[digits.length - 1]);
    expect(last4(pan)).toBe(pan.slice(-4));
  });

  it('does not collide on consecutive generation', () => {
    expect(generateLuhnPan()).not.toBe(generateLuhnPan());
  });
});
