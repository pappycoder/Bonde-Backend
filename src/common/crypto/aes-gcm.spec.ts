import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './aes-gcm.js';

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
