/**
 * `@rook/auth` — authentication and authorisation primitives.
 *
 * Deliberately has no database or HTTP dependency. Password hashing, token
 * handling and capability resolution are pure functions over configuration,
 * which keeps the security-critical logic testable in isolation and keeps the
 * repositories free of cryptography.
 */

export {
  createPasswordHasher,
  createTimingEqualiserHash,
  parsePhcParameters,
  type PasswordHasher,
} from './password.js';

export {
  createSessionTokenService,
  parseBearerToken,
  generateJoinCode,
  type SessionTokenService,
} from './tokens.js';

export {
  createSessionAuthenticator,
  type SessionAuthenticator,
  type AuthenticatedIdentity,
  type AuthenticationResult,
  type AuthenticationFailure,
  type SessionLookupResult,
} from './session-authenticator.js';

export {
  can,
  canDeleteMessage,
  canEditMessage,
  capabilities,
  capabilitiesFor,
  hasAtLeastRole,
  type AuthorizationContext,
  type Capability,
} from './authorization.js';
