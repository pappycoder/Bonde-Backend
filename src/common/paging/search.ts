/**
 * Shared free-text search helpers. `q` matches any of the declared string
 * fields with a case-insensitive `contains` filter.
 */

export interface SearchWhere {
  OR: Array<Record<string, unknown>>;
}

/** Build a case-insensitive `contains` Prisma StringFilter fragment. */
export function searchString(value: string): Record<string, unknown> {
  return { contains: value, mode: 'insensitive' };
}

/**
 * Build a Prisma `OR` search fragment over top-level string fields, or
 * `undefined` when `q` is empty or there are no searchable fields.
 */
export function qWhere(q: string | undefined, fields: readonly string[]): SearchWhere | undefined {
  const term = q?.trim();
  if (!term || fields.length === 0) return undefined;
  return { OR: fields.map((field) => ({ [field]: searchString(term) })) };
}
