/** Optional provider fields must never turn an unknown outcome into success/failure. */
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
