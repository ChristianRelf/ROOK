import { errorStatusByCode, type ErrorCode, type FieldError } from '@rook/contracts';
import type { ZodError } from 'zod';

/**
 * The one error type routes throw.
 *
 * Carrying a contract `ErrorCode` rather than a bare status means the HTTP
 * status is derived from the code in exactly one place, so two routes cannot
 * return different statuses for the same condition. The client branches on the
 * code and never on the message.
 *
 * Messages here are written to be shown to a user. Anything internal — a
 * constraint name, a storage key, a stack — stays in the log and never reaches
 * the response body.
 */
export class HttpProblem extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields: FieldError[] | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      fields?: FieldError[];
      retryAfterSeconds?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HttpProblem';
    this.code = code;
    this.status = errorStatusByCode[code];
    this.fields = options.fields;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Shorthands for the conditions routes hit most. */
export const problems = {
  validation: (fields: FieldError[]) =>
    new HttpProblem('validation_failed', 'Some fields need correcting.', { fields }),

  unauthenticated: () => new HttpProblem('unauthenticated', 'Sign in to continue.'),

  invalidCredentials: () =>
    // One message for "no such account" and "wrong password", so login cannot
    // be used to discover which usernames exist.
    new HttpProblem('invalid_credentials', 'That username or password is incorrect.'),

  forbidden: (message = 'You do not have permission to do that.') =>
    new HttpProblem('forbidden', message),

  notFound: (what: string) => new HttpProblem('not_found', `${what} could not be found.`),

  channelNotFound: () =>
    // Also returned when the caller is simply not a member: confirming that a
    // channel exists is itself a disclosure.
    new HttpProblem('channel_not_found', 'That channel could not be found.'),

  communityNotFound: () =>
    new HttpProblem('community_not_found', 'That community could not be found.'),

  messageNotFound: () => new HttpProblem('message_not_found', 'That message could not be found.'),

  conflict: (code: ErrorCode, message: string) => new HttpProblem(code, message),

  internal: (cause?: unknown) =>
    new HttpProblem('internal_error', 'Something went wrong. Please try again.', { cause }),
} as const;

/**
 * Converts a Zod failure into field errors the client can render inline.
 *
 * The path is joined with dots so `attachmentIds.0` points at the offending
 * array element rather than just the array.
 */
export function toFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}
