import { createHmac } from 'node:crypto';

/**
 * Keyed SHA-256 digest, hex-encoded.
 *
 * Unlike a bare SHA-256 digest, the secret (pepper) makes the output
 * unreproducible without the key — mandatory for low-entropy identifiers such
 * as an 11-digit BVN/NIN, which a plain hash would let anyone brute-force from
 * a database dump. The secret never leaves the server and is never stored.
 */
export function hmacSha256(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}
