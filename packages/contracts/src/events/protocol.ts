import { z } from 'zod';

/**
 * Realtime protocol versioning.
 *
 * The version is negotiated on connect rather than inferred. A desktop client
 * is installed software: an old build can still be running weeks after the
 * server is updated, so the server has to know which dialect it is talking and
 * the client has to be told plainly when it is too old, instead of failing
 * with a confusing parse error deep in a handler.
 *
 * Compatibility rules for changing this contract:
 *
 *   - Adding a new server event type is backwards compatible. Clients ignore
 *     event types they do not recognise (see `unknownEventPolicy` below).
 *   - Adding an optional field to an existing payload is compatible.
 *   - Removing a field, renaming one, or changing its type is breaking and
 *     requires bumping `PROTOCOL_VERSION`.
 */

export const PROTOCOL_VERSION = 1;

/** Versions this build can speak. Lets one server support a rollover window. */
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;

/**
 * Clients must skip unrecognised event types rather than erroring, so a server
 * can ship a new event before every client has updated. This constant exists
 * to make that rule discoverable from the contract itself.
 */
export const unknownEventPolicy = 'ignore' as const;

/**
 * WebSocket close codes.
 *
 * 4000-4999 is the application-defined range. The distinction that matters to
 * the client is whether reconnecting could possibly help: a bad token or an
 * unsupported protocol version will fail again immediately, so the client must
 * stop and surface the problem instead of looping.
 */
export const closeCodes = {
  /** Normal shutdown, e.g. the gateway is being redeployed. Reconnect. */
  goingAway: 4000,
  /** Token missing, invalid or expired. Do not retry; re-authenticate. */
  authenticationFailed: 4001,
  /** Client never sent `identify` in time. Reconnect is fine. */
  identifyTimeout: 4002,
  /** Client build is too old or too new. Do not retry; prompt to update. */
  unsupportedProtocolVersion: 4003,
  /** Inbound frame rate exceeded. Reconnect after a backoff. */
  rateLimited: 4004,
  /** Client stopped answering heartbeats. Reconnect. */
  heartbeatTimeout: 4005,
  /** Client could not keep up with the outbound stream. Reconnect and resync. */
  backpressure: 4006,
  /** Frame was not valid JSON or failed schema validation. */
  invalidFrame: 4007,
  /** The session was revoked, e.g. the user logged out elsewhere. */
  sessionRevoked: 4008,
} as const;

export type CloseCode = (typeof closeCodes)[keyof typeof closeCodes];

/** Close codes where reconnecting with the same credentials cannot succeed. */
export const fatalCloseCodes: readonly CloseCode[] = [
  closeCodes.authenticationFailed,
  closeCodes.unsupportedProtocolVersion,
  closeCodes.sessionRevoked,
];

export const protocolVersionSchema = z
  .number()
  .int()
  .refine(
    (value): value is (typeof SUPPORTED_PROTOCOL_VERSIONS)[number] =>
      (SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(value),
    { error: `unsupported protocol version; this server speaks ${PROTOCOL_VERSION}` },
  );
