import { describe, expect, it } from 'vitest';

import {
  isUniqueViolation,
  PG_CHECK_VIOLATION,
  PG_NOT_NULL_VIOLATION,
  PG_UNIQUE_VIOLATION,
  pgErrorOf,
} from './errors.js';

/** A driver error as `pg` throws it. */
function driverError(
  code: string,
  constraint?: string,
  column?: string,
): Error {
  return Object.assign(new Error('violation'), { code, constraint, column });
}

describe('pgErrorOf', () => {
  it('reads SQLSTATE, constraint and column through wrapping errors', () => {
    const notNull = new Error('Failed query', {
      cause: driverError(PG_NOT_NULL_VIOLATION, undefined, 'name'),
    });
    expect(pgErrorOf(notNull)).toEqual({
      code: PG_NOT_NULL_VIOLATION,
      constraint: undefined,
      column: 'name',
    });
    expect(
      pgErrorOf(driverError(PG_CHECK_VIOLATION, 'devices_kind_api_key_check')),
    ).toMatchObject({ constraint: 'devices_kind_api_key_check' });
  });

  it('is undefined for errors without a SQLSTATE', () => {
    expect(
      pgErrorOf(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })),
    ).toBeUndefined();
    expect(pgErrorOf(new Error('boom'))).toBeUndefined();
    expect(pgErrorOf('23505')).toBeUndefined();
  });
});

describe('isUniqueViolation', () => {
  it('recognizes a unique violation of the driver', () => {
    expect(isUniqueViolation(driverError(PG_UNIQUE_VIOLATION, 'x_key'))).toBe(
      true,
    );
  });

  it('looks through wrapping errors (drizzle DrizzleQueryError)', () => {
    const wrapped = new Error('Failed query', {
      cause: driverError(PG_UNIQUE_VIOLATION, 'devices_org_name_key'),
    });
    expect(isUniqueViolation(wrapped, 'devices_org_name_key')).toBe(true);
  });

  it('checks the constraint name when given', () => {
    expect(
      isUniqueViolation(driverError(PG_UNIQUE_VIOLATION, 'a_key'), 'b_key'),
    ).toBe(false);
  });

  it('ignores other errors and non-errors', () => {
    expect(isUniqueViolation(driverError('23503', 'fk'))).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation({ code: PG_UNIQUE_VIOLATION })).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
