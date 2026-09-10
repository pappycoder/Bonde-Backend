/**
 * Bank-style account number generation (Luhn algorithm). The payload is a run
 * of `length - 1` random digits; the final digit is the Luhn check digit, so
 * generated numbers always pass a Luhn checksum (schema: bank-style notation).
 */

export function luhnCheckDigit(payload: number[]): number {
  let sum = 0;
  const reversed = [...payload].reverse();
  for (let i = 0; i < reversed.length; i++) {
    let digit = reversed[i];
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10;
}

export function generateLuhnAccountNumber(length = 10): string {
  const payload = Array.from({ length: length - 1 }, () => Math.floor(Math.random() * 10));
  return [...payload, luhnCheckDigit(payload)].join('');
}
