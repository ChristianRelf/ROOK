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
  generateInviteCode,
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

/**
 * Re-exported from `@rook/contracts`, where the capability rules now live so
 * the desktop client can resolve the same ones the server enforces. Kept
 * exported here because every server-side caller reaches for authorisation
 * through `@rook/auth`, and making them all import from two packages would be
 * churn with no benefit.
 */
export {
  can,
  canAssignRole,
  canDeleteMessage,
  canEditMessage,
  canManageMember,
  capabilities,
  capabilitiesFor,
  hasAtLeastRole,
  type AuthorizationContext,
  type Capability,
} from '@rook/contracts';
