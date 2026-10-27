import type { z } from 'zod';
import { problems, toFieldErrors } from './http-error.js';

/**
 * Request validation against the shared contract schemas.
 *
 * Every route parses its input through these helpers, and the parsed value is
 * what the handler uses — never `request.body` directly. That matters because
 * the schemas also *normalise*: usernames are lowercased, channel names are
 * slugified, message content is trimmed. Reading the raw body after validating
 * would silently skip all of that.
 *
 * A deliberate choice not to use Fastify's JSON-schema validation: the
 * contracts are Zod schemas shared with the desktop client, and maintaining a
 * second JSON-schema copy per route is how the two drift apart.
 */

export function parseBody<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
): z.output<Schema> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw problems.validation(toFieldErrors(result.error));
  }
  return result.data;
}

/**
 * Parses a query string.
 *
 * Query values are always strings, so the schemas use coercion for numeric
 * fields (see `paginationQuerySchema`).
 */
export function parseQuery<Schema extends z.ZodType>(
  schema: Schema,
  query: unknown,
): z.output<Schema> {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw problems.validation(toFieldErrors(result.error));
  }
  return result.data;
}

/**
 * Parses route parameters.
 *
 * Validating these is not a formality: an id reaches the database as a `uuid`
 * parameter, and letting arbitrary text through turns a typo in a URL into a
 * driver-level 500 instead of a clean 400.
 */
export function parseParams<Schema extends z.ZodType>(
  schema: Schema,
  params: unknown,
): z.output<Schema> {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw problems.validation(toFieldErrors(result.error));
  }
  return result.data;
}
