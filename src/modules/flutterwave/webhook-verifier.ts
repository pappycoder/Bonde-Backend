import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Flutterwave webhook signature.
 *
 * Primary scheme: the `flutterwave-signature` header carries the base64
 * HMAC-SHA256 of the **raw** request body, keyed with the configured webhook
 * secret hash. Legacy fallback: the `verif-hash` header must equal the secret
 * hash. Both comparisons are constant-time; a length mismatch is rejected
 * before `timingSafeEqual` runs.
 */
export function verifyFlutterwaveWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  verifHashHeader: string | undefined,
  secret: string,
): boolean {
  if (!secret) return false;

  if (signatureHeader) {
    const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
    return safeEqual(expected, signatureHeader);
  }
  if (verifHashHeader) {
    return safeEqual(secret, verifHashHeader);
  }
  return false;
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
