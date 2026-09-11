/**
 * Turn an enum-ish UPPER_SNAKE value into plain lowercase words for
 * notification copy, e.g. `LARGE_AMOUNT` -> `large amount`.
 */
export function humanizeLabel(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}
