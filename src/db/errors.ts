/** SQLSTATE of a unique constraint violation. */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * `true` when `error` (or one of its causes — drizzle wraps driver errors in
 * `DrizzleQueryError`) is a PostgreSQL unique violation, optionally of the
 * named constraint.
 *
 * @example
 * catch (error) {
 *   if (isUniqueViolation(error, 'notes_org_mmsi_title_key')) throw new ConflictError(…);
 *   throw error;
 * }
 */
export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if ('code' in current && current.code === PG_UNIQUE_VIOLATION) {
      return (
        constraint === undefined ||
        ('constraint' in current && current.constraint === constraint)
      );
    }
    current = current.cause;
  }
  return false;
}
