import type { SessionTokenService } from './tokens.js';

/**
 * Turns a bearer token into an authenticated identity.
 *
 * Both the HTTP API and the realtime gateway need exactly this, and it must
 * behave identically in both — a token the API rejects must not be accepted on
 * a WebSocket. Rather than duplicating the logic, it lives here once.
 *
 * The session lookup is injected as a callback, which is what keeps
 * `@rook/auth` free of any database dependency: the package stays pure
 * functions over configuration, and the caller supplies the repository it
 * already has.
 */

export interface AuthenticatedIdentity<User> {
  readonly sessionId: string;
  readonly user: User;
  readonly expiresAt: Date;
}

export type SessionLookupResult<User> =
  | {
      readonly sessionId: string;
      readonly user: User;
      readonly expiresAt: Date;
    }
  | undefined;

export type AuthenticationFailure = 'missing_token' | 'invalid_token';

export type AuthenticationResult<User> =
  | { readonly ok: true; readonly identity: AuthenticatedIdentity<User> }
  | { readonly ok: false; readonly reason: AuthenticationFailure };

export interface SessionAuthenticator<User> {
  /** Resolves a raw token. Expiry and revocation are the lookup's job. */
  authenticate: (token: string | undefined) => Promise<AuthenticationResult<User>>;
}

export function createSessionAuthenticator<User>(options: {
  readonly tokens: SessionTokenService;
  /**
   * Must return undefined for sessions that are expired or revoked, not just
   * for ones that do not exist — the repository query filters on both.
   */
  readonly findSessionByTokenHash: (tokenHash: Buffer) => Promise<SessionLookupResult<User>>;
}): SessionAuthenticator<User> {
  const { tokens, findSessionByTokenHash } = options;

  return {
    async authenticate(token) {
      if (token === undefined || token.length === 0) {
        return { ok: false, reason: 'missing_token' };
      }

      // The raw token is hashed before it is used for anything, so it never
      // appears in a query parameter or a log line.
      const tokenHash = tokens.hashToken(token);
      const session = await findSessionByTokenHash(tokenHash);

      if (session === undefined) {
        // One reason for every failure: not-found, expired and revoked are
        // deliberately indistinguishable to the caller.
        return { ok: false, reason: 'invalid_token' };
      }

      return {
        ok: true,
        identity: {
          sessionId: session.sessionId,
          user: session.user,
          expiresAt: session.expiresAt,
        },
      };
    },
  };
}
