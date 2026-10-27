import { z } from 'zod';

/**
 * The shared error vocabulary.
 *
 * Clients branch on `code`, never on `message`. Messages are for humans and
 * may be reworded at any time; codes are part of the contract.
 *
 * Note what is *not* here: no `user_not_found` distinct from
 * `invalid_credentials`. Telling an attacker whether an account exists turns
 * login into a username oracle, so registration and login collapse those cases
 * into one response.
 */

export const errorCodeSchema = z.enum([
  // Request shape
  'validation_failed',
  'malformed_request',

  // Authentication
  'invalid_credentials',
  'unauthenticated',
  'session_expired',
  'username_taken',
  'email_taken',

  // Authorisation
  'forbidden',
  'not_a_member',
  'insufficient_role',

  // Resources
  'not_found',
  'channel_not_found',
  'community_not_found',
  'message_not_found',
  'invalid_join_code',
  'already_a_member',
  'conflict',

  // Media
  'upload_too_large',
  'unsupported_media_type',
  'media_not_ready',
  'media_processing_failed',

  // Throttling and capacity
  'rate_limited',
  'payload_too_large',

  // Server
  'internal_error',
  'service_unavailable',
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** One field-level problem, for rendering errors next to the input. */
export const fieldErrorSchema = z.object({
  /** Dotted path into the request body, e.g. `content` or `attachmentIds.0`. */
  path: z.string(),
  message: z.string(),
});

export type FieldError = z.infer<typeof fieldErrorSchema>;

/**
 * The single error envelope every failing API response uses.
 *
 * One shape means the client has exactly one error path to handle, rather
 * than guessing per endpoint.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    /** Safe to show a user. Never contains internal detail or stack traces. */
    message: z.string(),
    fields: z.array(fieldErrorSchema).optional(),
    /** Echoes the request id, so a user can quote it in a bug report. */
    requestId: z.string().optional(),
    /** Present on `rate_limited`: seconds the client should wait. */
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/** The HTTP status each code maps to. Keeps statuses consistent across routes. */
export const errorStatusByCode: Readonly<Record<ErrorCode, number>> = {
  validation_failed: 400,
  malformed_request: 400,

  invalid_credentials: 401,
  unauthenticated: 401,
  session_expired: 401,
  username_taken: 409,
  email_taken: 409,

  forbidden: 403,
  not_a_member: 403,
  insufficient_role: 403,

  not_found: 404,
  channel_not_found: 404,
  community_not_found: 404,
  message_not_found: 404,
  invalid_join_code: 404,
  already_a_member: 409,
  conflict: 409,

  upload_too_large: 413,
  unsupported_media_type: 415,
  media_not_ready: 409,
  media_processing_failed: 422,

  rate_limited: 429,
  payload_too_large: 413,

  internal_error: 500,
  service_unavailable: 503,
};
