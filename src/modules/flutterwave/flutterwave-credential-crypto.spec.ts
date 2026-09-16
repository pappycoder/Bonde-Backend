import { describe, expect, it } from 'vitest';
import { AesGcmCardCredentialEncryptor } from './flutterwave-credential-crypto.js';

const KEY = 'a'.repeat(64);

function makeEncryptor() {
  const config = { get: vi.fn(() => KEY) };
  return new AesGcmCardCredentialEncryptor(config as never);
}

describe('AesGcmCardCredentialEncryptor', () => {
  it('encrypts with a random IV (two encryptions differ) and never stores plaintext', () => {
    const encryptor = makeEncryptor();
    const a = encryptor.encryptPan('5399838383838381');
    const b = encryptor.encryptPan('5399838383838381');
    expect(a).not.toBe(b);
    expect(a.startsWith('enc::')).toBe(true);
    expect(a).not.toContain('5399838383838381');
  });

  it('round-trips PAN + CVV via decrypt', () => {
    const encryptor = makeEncryptor();
    const encPan = encryptor.encryptPan('5399838383838381');
    const encCvv = encryptor.encryptCvv('123');
    expect(encryptor.decrypt(encPan, encCvv)).toEqual({ pan: '5399838383838381', cvv: '123' });
  });

  it('returns an empty CVV when none was provided', () => {
    const encryptor = makeEncryptor();
    const encPan = encryptor.encryptPan('5399838383838381');
    expect(encryptor.decrypt(encPan)).toEqual({ pan: '5399838383838381', cvv: '' });
  });
});
