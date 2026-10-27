/**
 * Opaque pagination cursors.
 *
 * A cursor currently encodes just a message id, which is enough because
 * UUIDv7 ids sort chronologically. It is still wrapped and base64url-encoded
 * rather than handed over raw, for two reasons:
 *
 *   1. Clients that cannot read a cursor cannot come to depend on its
 *      contents. When a shard or partition hint is added later, old clients
 *      keep working because they only ever echoed the value back.
 *
 *   2. A version tag means a future format change is detected and rejected
 *      cleanly, instead of being misparsed as an id.
 *
 * Cursors are not signed. They encode a position in a channel the caller has
 * already been authorised for, so forging one grants nothing that a direct
 * request would not — authorisation is checked on every call regardless.
 */

const CURSOR_VERSION = 'v1';

export class InvalidCursorError extends Error {
  constructor(reason: string) {
    super(`Invalid pagination cursor: ${reason}`);
    this.name = 'InvalidCursorError';
  }
}

export function encodeCursor(id: string): string {
  return Buffer.from(`${CURSOR_VERSION}:${id}`, 'utf8').toString('base64url');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Decodes a cursor, throwing `InvalidCursorError` on anything malformed.
 *
 * Validating the decoded id against the UUID pattern matters: the value goes
 * into a query as a `uuid` parameter, and letting arbitrary text through would
 * surface as an opaque 500 from the driver rather than a clear 400.
 */
export function decodeCursor(cursor: string): string {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new InvalidCursorError('not valid base64url');
  }

  const separator = decoded.indexOf(':');
  if (separator === -1) {
    throw new InvalidCursorError('missing version prefix');
  }

  const version = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);

  if (version !== CURSOR_VERSION) {
    throw new InvalidCursorError(`unsupported version "${version}"`);
  }
  if (!UUID_PATTERN.test(id)) {
    throw new InvalidCursorError('payload is not a UUID');
  }

  return id;
}

/** Decodes an optional cursor, mapping absence to undefined. */
export function decodeOptionalCursor(cursor: string | undefined): string | undefined {
  return cursor === undefined ? undefined : decodeCursor(cursor);
}
