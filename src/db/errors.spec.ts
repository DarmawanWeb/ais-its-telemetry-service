import { describe, expect, it } from 'vitest';

import { isUniqueViolation, PG_UNIQUE_VIOLATION } from './errors.js';

/** A driver error as `pg` throws it. */
function driverError(code: string, constraint?: string): Error {
  return Object.assign(new Error('duplicate key value'), { code, constraint });
}

describe('isUniqueViolation', () => {
  it('recognizes a unique violation of the driver', () => {
    expect(isUniqueViolation(driverError(PG_UNIQUE_VIOLATION, 'x_key'))).toBe(
      true,
    );
  });

  it('looks through wrapping errors (drizzle DrizzleQueryError)', () => {
    const wrapped = new Error('Failed query', {
      cause: driverError(PG_UNIQUE_VIOLATION, 'notes_org_mmsi_title_key'),
    });
    expect(isUniqueViolation(wrapped, 'notes_org_mmsi_title_key')).toBe(true);
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
