/** SQLSTATE of a unique constraint violation. */
export const PG_UNIQUE_VIOLATION = '23505';

/** SQLSTATE of a NOT NULL violation. */
export const PG_NOT_NULL_VIOLATION = '23502';

/** SQLSTATE of a CHECK constraint violation. */
export const PG_CHECK_VIOLATION = '23514';

/** The fields of a PostgreSQL error (`pg` `DatabaseError`) used to map it. */
export interface PgErrorFields {
  /** SQLSTATE, e.g. `23505`. */
  readonly code: string;
  readonly constraint: string | undefined;
  readonly column: string | undefined;
}

/**
 * The PostgreSQL error behind `error`, which may be wrapped (drizzle wraps
 * driver errors in `DrizzleQueryError`, the cause chain is searched).
 *
 * @returns `undefined` when no error in the chain carries a SQLSTATE.
 */
export function pgErrorOf(error: unknown): PgErrorFields | undefined {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(current.code)
    ) {
      return {
        code: current.code,
        constraint: stringField(current, 'constraint'),
        column: stringField(current, 'column'),
      };
    }
    current = current.cause;
  }
  return undefined;
}

/**
 * `true` when `error` (or one of its causes) is a PostgreSQL unique
 * violation, optionally of the named constraint.
 *
 * @example
 * catch (error) {
 *   if (isUniqueViolation(error, 'devices_org_name_key')) throw new DeviceNameTakenError(name, error);
 *   throw error;
 * }
 */
export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  const pg = pgErrorOf(error);
  return (
    pg?.code === PG_UNIQUE_VIOLATION &&
    (constraint === undefined || pg.constraint === constraint)
  );
}

function stringField(error: Error, field: string): string | undefined {
  const value: unknown = (error as unknown as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}
