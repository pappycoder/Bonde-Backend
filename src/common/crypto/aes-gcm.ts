import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_LENGTH = 12;

function toKey(key: string): Buffer {
  const bytes = Buffer.from(key, 'hex');
  if (bytes.length !== 32) {
    throw new Error('CARD_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  return bytes;
}

export function encrypt(plaintext: string, key: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', toKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['enc', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(
    '::',
  );
}

export function decrypt(payload: string, key: string): string {
  const [prefix, ivB64, tagB64, cipherB64] = payload.split('::');
  if (prefix !== 'enc' || !ivB64 || !tagB64 || !cipherB64) {
    throw new Error('Invalid encrypted payload');
  }
  const decipher = createDecipheriv('aes-256-gcm', toKey(key), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
