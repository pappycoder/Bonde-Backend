import { BadRequestException } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FilterOperator =
  'eq' | 'contains' | 'startsWith' | 'endsWith' | 'gt' | 'gte' | 'lt' | 'lte';

export interface FilterEntry {
  field: string;
  op: FilterOperator;
  value: string;
  /**
   * `true` when the `field:op:value` form was used. Implicit entries
   * (`field:value`) resolve their operator per field kind — `contains` for
   * strings, `eq` for everything else.
   */
  opExplicit: boolean;
}

export type FilterFieldKind = 'string' | 'boolean' | 'int' | 'decimal' | 'datetime' | 'enum';

export interface FilterFieldSpec {
  kind: FilterFieldKind;
  /** Allowed operators for this field. Defaults to `DEFAULT_OPS[kind]`. */
  ops?: readonly FilterOperator[];
  /**
   * Custom coercion that receives the raw query-string value and returns
   * the value to place in the Prisma where clause. Defaults to
   * `coerceFilterValue(kind)`.
   */
  coerce?(raw: string): unknown;
}

// ---------------------------------------------------------------------------
// Operator constants
// ---------------------------------------------------------------------------

export const FILTER_OPERATORS: readonly FilterOperator[] = [
  'eq',
  'contains',
  'startsWith',
  'endsWith',
  'gt',
  'gte',
  'lt',
  'lte',
];

const STRING_OPS: readonly FilterOperator[] = ['eq', 'contains', 'startsWith', 'endsWith'];
const COMPARABLE_OPS: readonly FilterOperator[] = ['eq', 'gt', 'gte', 'lt', 'lte'];
const EQ_OPS: readonly FilterOperator[] = ['eq'];

const DEFAULT_OPS: Record<FilterFieldKind, readonly FilterOperator[]> = {
  string: STRING_OPS,
  boolean: EQ_OPS,
  int: COMPARABLE_OPS,
  decimal: COMPARABLE_OPS,
  datetime: COMPARABLE_OPS,
  enum: EQ_OPS,
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the repeatable `filter` query param into structured entries.
 *
 * Accepted forms:
 * - `field:value`      → implicit op (resolved per field kind at build time:
 *                        `contains` for strings, `eq` otherwise)
 * - `field:op:value`   → explicit operator (the raw value may itself contain `:`)
 *
 * Throws `BadRequestException` on invalid syntax.
 */
export function parseFilterEntries(raw: string | string[] | undefined): FilterEntry[] {
  const entries = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.length > 0 ? [raw] : [];
  return entries.map(parseFilterEntry);
}

function parseFilterEntry(entry: string): FilterEntry {
  const sep = entry.indexOf(':');
  if (sep <= 0) throw new BadRequestException('filter must be "field:value"');
  const field = entry.slice(0, sep);
  const rest = entry.slice(sep + 1);

  for (const op of FILTER_OPERATORS) {
    if (rest.startsWith(`${op}:`)) {
      return { field, op, value: rest.slice(op.length + 1), opExplicit: true };
    }
  }

  return { field, op: 'eq', value: rest, opExplicit: false };
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

const INT_RE = /^[+-]?[0-9]+$/;
const DECIMAL_RE = /^[+-]?[0-9]+(\.[0-9]+)?$/;

/** Coerce a raw filter value to the appropriate JS type for a given kind. */
export function coerceFilterValue(kind: FilterFieldKind, raw: string): unknown {
  switch (kind) {
    case 'string':
    case 'enum':
      return raw;
    case 'boolean': {
      const lower = raw.toLowerCase();
      if (lower === 'true') return true;
      if (lower === 'false') return false;
      throw new BadRequestException('Boolean filter value must be "true" or "false"');
    }
    case 'int':
      if (!INT_RE.test(raw))
        throw new BadRequestException(`Integer filter value is invalid: ${raw}`);
      return Number(raw);
    case 'decimal':
      if (!DECIMAL_RE.test(raw))
        throw new BadRequestException(`Decimal filter value is invalid: ${raw}`);
      return raw;
    case 'datetime':
      if (Number.isNaN(Date.parse(raw)))
        throw new BadRequestException(`Date filter value is invalid: ${raw}`);
      return new Date(raw);
  }
}

// ---------------------------------------------------------------------------
// Where-fragment builders
// ---------------------------------------------------------------------------

/**
 * Build a single Prisma where-fragment for one filter entry.
 *
 * For `eq` the raw coerced value is returned directly; for other operators
 * a `{ [op]: value, mode?: 'insensitive' }` shape is produced.
 */
export function filterFragment(op: FilterOperator, coercedValue: unknown): unknown {
  switch (op) {
    case 'eq':
      return coercedValue;
    case 'contains':
      return { contains: coercedValue, mode: 'insensitive' };
    case 'startsWith':
      return { startsWith: coercedValue, mode: 'insensitive' };
    case 'endsWith':
      return { endsWith: coercedValue, mode: 'insensitive' };
    case 'gt':
      return { gt: coercedValue };
    case 'gte':
      return { gte: coercedValue };
    case 'lt':
      return { lt: coercedValue };
    case 'lte':
      return { lte: coercedValue };
  }
}

/**
 * Build a Prisma `where` fragment from parsed filter entries.
 *
 * @param entries  Parsed by `parseFilterEntries`.
 * @param fields   Map of allowed field name → spec describing its kind and
 *                 allowed operators.
 * @returns        A partial where object ready to be spread into the caller's
 *                 typed Prisma where clause.
 */
export function buildFilterWhere(
  entries: readonly FilterEntry[],
  fields: Record<string, FilterFieldSpec>,
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  for (const entry of entries) {
    const spec = fields[entry.field];
    if (!spec) throw new BadRequestException(`Unknown filter field "${entry.field}"`);
    const ops = spec.ops ?? DEFAULT_OPS[spec.kind];
    const op = entry.opExplicit ? entry.op : defaultOpFor(spec.kind);
    if (!ops.includes(op)) {
      throw new BadRequestException(`Operator "${op}" is not allowed on field "${entry.field}"`);
    }
    const coercedValue = spec.coerce
      ? spec.coerce(entry.value)
      : coerceFilterValue(spec.kind, entry.value);
    where[entry.field] = filterFragment(op, coercedValue);
  }
  return where;
}

/**
 * The operator an implicit `field:value` entry resolves to: `contains` for
 * strings (flexible partial match), equality for everything else.
 */
function defaultOpFor(kind: FilterFieldKind): FilterOperator {
  return kind === 'string' ? 'contains' : 'eq';
}
