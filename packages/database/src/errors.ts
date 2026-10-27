/**
 * Translating PostgreSQL errors into something the domain can branch on.
 *
 * Repositories must not leak driver errors upward: a caller should not have to
 * know that `23505` means a unique violation, and certainly should not parse
 * an English error message to find out which constraint failed.
 *
 * This matters most for the insert-and-catch pattern. Checking "does this
 * username exist?" before inserting is a race — two concurrent registrations
 * both see "no" and both insert. The correct approach is to let the unique
 * index arbitrate and interpret the resulting error, which needs reliable
 * constraint identification.
 */

/** The subset of PostgreSQL error codes this codebase reacts to. */
export const pgErrorCodes = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  lockNotAvailable: '55P03',
  queryCanceled: '57014',
} as const;

interface PostgresErrorShape {
  readonly code?: string;
  readonly constraint?: string;
  readonly detail?: string;
  readonly table?: string;
  readonly column?: string;
}

/** Narrows an unknown thrown value to something with Postgres error fields. */
function asPostgresError(error: unknown): PostgresErrorShape | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as PostgresErrorShape;
  return typeof candidate.code === 'string' ? candidate : undefined;
}

/** True when the error is a unique violation, optionally of a named constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = asPostgresError(error);
  if (pgError?.code !== pgErrorCodes.uniqueViolation) return false;
  return constraint === undefined || pgError.constraint === constraint;
}

export function isForeignKeyViolation(error: unknown, constraint?: string): boolean {
  const pgError = asPostgresError(error);
  if (pgError?.code !== pgErrorCodes.foreignKeyViolation) return false;
  return constraint === undefined || pgError.constraint === constraint;
}

export function isCheckViolation(error: unknown, constraint?: string): boolean {
  const pgError = asPostgresError(error);
  if (pgError?.code !== pgErrorCodes.checkViolation) return false;
  return constraint === undefined || pgError.constraint === constraint;
}

/**
 * True for errors worth retrying: serialisation failures and deadlocks.
 *
 * Postgres resolves a deadlock by cancelling one transaction, and the losing
 * side will typically succeed on a second attempt. Nothing else in this list
 * should be retried blindly.
 */
export function isRetryableTransactionError(error: unknown): boolean {
  const code = asPostgresError(error)?.code;
  return (
    code === pgErrorCodes.serializationFailure ||
    code === pgErrorCodes.deadlockDetected ||
    code === pgErrorCodes.lockNotAvailable
  );
}

/** True when the statement timeout fired. Surfaces as 503, not 500. */
export function isQueryCanceled(error: unknown): boolean {
  return asPostgresError(error)?.code === pgErrorCodes.queryCanceled;
}

/** The constraint name from a violation, for mapping to a domain error. */
export function violatedConstraint(error: unknown): string | undefined {
  return asPostgresError(error)?.constraint;
}

/**
 * Raised when a repository is asked for a row that must exist.
 *
 * Distinct from returning `undefined`: a lookup that legitimately may miss
 * returns `undefined`, whereas this means an invariant was broken — for
 * example, a message row referencing an author that is not there.
 */
export class RecordNotFoundError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} ${id} not found`);
    this.name = 'RecordNotFoundError';
  }
}
