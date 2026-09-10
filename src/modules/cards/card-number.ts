import { luhnCheckDigit } from '../../modules/accounts/account-number.js';

/**
 * Bank-style card number (PAN) generation. Generates a 16-digit number with a
 * `4` major industry identifier and a trailing Luhn check digit. The plaintext
 * PAN is encrypted before storage; `last4` is the plaintext display suffix.
 */

export function generateLuhnPan(): string {
  const payload = [4, ...Array.from({ length: 14 }, () => Math.floor(Math.random() * 10))];
  return [...payload, luhnCheckDigit(payload)].join('');
}

export function last4(pan: string): string {
  return pan.slice(-4);
}
