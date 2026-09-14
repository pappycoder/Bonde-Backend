import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyFlutterwaveWebhook } from './webhook-verifier.js';

const SECRET = 'whsec_bondetest';
const BODY = Buffer.from(JSON.stringify({ event: 'charge.completed', data: { id: 42 } }));

describe('verifyFlutterwaveWebhook', () => {
  it('accepts a valid HMAC-SHA256 base64 signature', () => {
    const sig = createHmac('sha256', SECRET).update(BODY).digest('base64');
    expect(verifyFlutterwaveWebhook(BODY, sig, undefined, SECRET)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const sig = createHmac('sha256', 'wrong-secret').update(BODY).digest('base64');
    expect(verifyFlutterwaveWebhook(BODY, sig, undefined, SECRET)).toBe(false);
  });

  it('rejects a signature over a different body', () => {
    const sig = createHmac('sha256', SECRET).update(Buffer.from('other')).digest('base64');
    expect(verifyFlutterwaveWebhook(BODY, sig, undefined, SECRET)).toBe(false);
  });

  it('falls back to the legacy verif-hash header', () => {
    expect(verifyFlutterwaveWebhook(BODY, undefined, SECRET, SECRET)).toBe(true);
  });

  it('rejects a mismatched verif-hash', () => {
    expect(verifyFlutterwaveWebhook(BODY, undefined, 'other-hash', SECRET)).toBe(false);
  });

  it('rejects when neither header is present', () => {
    expect(verifyFlutterwaveWebhook(BODY, undefined, undefined, SECRET)).toBe(false);
  });

  it('rejects when the secret is empty', () => {
    const sig = createHmac('sha256', '').update(BODY).digest('base64');
    expect(verifyFlutterwaveWebhook(BODY, sig, undefined, '')).toBe(false);
  });
});
