import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  buildFilterWhere,
  coerceFilterValue,
  filterFragment,
  parseFilterEntries,
  type FilterFieldSpec,
} from './filter.js';
import { qWhere } from './search.js';

const FIELDS: Record<string, FilterFieldSpec> = {
  status: { kind: 'enum' },
  title: { kind: 'string' },
  amount: { kind: 'decimal' },
};

describe('parseFilterEntries', () => {
  it('defaults to equality for bare field:value', () => {
    expect(parseFilterEntries('status:PENDING')).toEqual([
      { field: 'status', op: 'eq', value: 'PENDING' },
    ]);
    expect(parseFilterEntries(undefined)).toEqual([]);
  });

  it('keeps the operator when a full field:op:value is given', () => {
    expect(parseFilterEntries('title:startsWith:card,')).toEqual([
      { field: 'title', op: 'startsWith', value: 'card,' },
    ]);
  });

  it('preserves colons inside datetime values', () => {
    const raw = 'createdAt:gte:2026-09-13T10:30:00.000Z';
    expect(parseFilterEntries(raw)).toEqual([
      { field: 'createdAt', op: 'gte', value: '2026-09-13T10:30:00.000Z' },
    ]);
  });

  it('accepts repeated params', () => {
    expect(parseFilterEntries(['status:PENDING', 'amount:gt:100'])).toEqual([
      { field: 'status', op: 'eq', value: 'PENDING' },
      { field: 'amount', op: 'gt', value: '100' },
    ]);
  });

  it('rejects malformed entries', () => {
    expect(() => parseFilterEntries('novalue')).toThrow(BadRequestException);
  });
});

describe('coerceFilterValue', () => {
  it('coerces booleans', () => {
    expect(coerceFilterValue('boolean', 'true')).toBe(true);
    expect(coerceFilterValue('boolean', 'FALSE')).toBe(false);
    expect(() => coerceFilterValue('boolean', 'yes')).toThrow(BadRequestException);
  });

  it('coerces ints and datetimes', () => {
    expect(coerceFilterValue('int', '-12')).toBe(-12);
    expect(() => coerceFilterValue('int', '1.5')).toThrow(BadRequestException);
    expect(coerceFilterValue('datetime', '2026-09-13T10:30:00.000Z')).toBeInstanceOf(Date);
    expect(() => coerceFilterValue('datetime', 'yesterday')).toThrow(BadRequestException);
  });
});

describe('filterFragment', () => {
  it('returns the raw value for eq', () => {
    expect(filterFragment('eq', 'x')).toBe('x');
  });

  it('is case-insensitive for text operators', () => {
    expect(filterFragment('contains', 'mc')).toEqual({ contains: 'mc', mode: 'insensitive' });
    expect(filterFragment('startsWith', 'm')).toEqual({ startsWith: 'm', mode: 'insensitive' });
    expect(filterFragment('endsWith', 'c')).toEqual({ endsWith: 'c', mode: 'insensitive' });
  });

  it('uses comparison shapes for range operators', () => {
    expect(filterFragment('gt', 12)).toEqual({ gt: 12 });
    expect(filterFragment('lte', new Date(0))).toEqual({ lte: new Date(0) });
  });
});

describe('buildFilterWhere', () => {
  it('rejects unknown fields', () => {
    expect(() => buildFilterWhere(parseFilterEntries('nope:x'), FIELDS)).toThrow(
      BadRequestException,
    );
  });

  it('rejects operators not allowed for the field kind', () => {
    expect(() => buildFilterWhere(parseFilterEntries('status:contains:EN'), FIELDS)).toThrow(
      'Operator "contains" is not allowed on field "status"',
    );
  });

  it('builds typed where fragments', () => {
    expect(
      buildFilterWhere(parseFilterEntries(['amount:gt:100', 'title:startsWith:vac']), FIELDS),
    ).toEqual({
      amount: { gt: '100' },
      title: { startsWith: 'vac', mode: 'insensitive' },
    });
  });
});

describe('qWhere', () => {
  it('returns undefined when no q is given', () => {
    expect(qWhere(undefined, ['title'])).toBeUndefined();
    expect(qWhere('', ['title'])).toBeUndefined();
    expect(qWhere('   ', ['title'])).toBeUndefined();
  });

  it('builds an OR across the searchable fields', () => {
    expect(qWhere('cards', ['title', 'content'])).toEqual({
      OR: [
        { title: { contains: 'cards', mode: 'insensitive' } },
        { content: { contains: 'cards', mode: 'insensitive' } },
      ],
    });
  });
});
