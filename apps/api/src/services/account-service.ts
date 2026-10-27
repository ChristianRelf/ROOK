import type { CurrentUser, MediaAssetId, SessionId, UserId } from '@rook/contracts';
import type { SessionConfig } from '@rook/config';
import type { DatabaseClient, Repositories } from '@rook/database';
import type { PasswordHasher, SessionTokenService } from '@rook/auth';
import type { Logger } from '@rook/observability';

/**
 * Registration, login, logout and profile updates.
 *
 * Two details here are security-relevant rather than incidental.
 *
 * **Login timing.** When no account matches the identifier, the handler still
 * performs a password verification against a throwaway hash before failing.
 * Without it, a missing account returns in microseconds while a real one takes
 * however long Argon2 takes, and that gap alone reveals which usernames exist
 * — which would undo the point of returning one `invalid_credentials` code for
 * both cases.
 *
 * **Opportunistic rehashing.** A successful login whose stored hash predates
 * the current Argon2 cost parameters is re-hashed in place. Raising the cost
 * in configuration therefore upgrades accounts as people sign in, instead of
 * leaving old hashes weak forever.
 */

export type RegisterResult =
  | {
      readonly ok: true;
      readonly user: CurrentUser;
      readonly token: string;
      readonly expiresAt: Date;
    }
  | { readonly ok: false; readonly reason: 'username_taken' | 'email_taken' };

export type LoginResult =
  | {
      readonly ok: true;
      readonly user: CurrentUser;
      readonly token: string;
      readonly expiresAt: Date;
    }
  | { readonly ok: false; readonly reason: 'invalid_credentials' };

export interface AccountService {
  register: (input: {
    username: string;
    email: string;
    password: string;
    displayName: string | undefined;
    userAgent: string | undefined;
  }) => Promise<RegisterResult>;

  login: (input: {
    identifier: string;
    password: string;
    userAgent: string | undefined;
  }) => Promise<LoginResult>;

  logout: (sessionId: SessionId) => Promise<void>;

  updateProfile: (
    userId: UserId,
    changes: { displayName?: string; avatarAssetId?: MediaAssetId | null },
  ) => Promise<CurrentUser | undefined>;
}

export function createAccountService(options: {
  readonly db: DatabaseClient;
  readonly repositories: Repositories;
  readonly passwords: PasswordHasher;
  readonly tokens: SessionTokenService;
  readonly config: SessionConfig;
  readonly logger: Logger;
}): AccountService {
  const { repositories, passwords, tokens, logger } = options;

  /**
   * A hash to verify against when no account was found, so the failure path
   * costs the same as the success path. Computed lazily once and reused.
   */
  let decoyHash: Promise<string> | undefined;
  const getDecoyHash = (): Promise<string> => {
    decoyHash ??= passwords.hash('rook-login-timing-equaliser');
    return decoyHash;
  };

  async function issueSession(
    userId: UserId,
    userAgent: string | undefined,
  ): Promise<{ token: string; expiresAt: Date }> {
    const { token, tokenHash } = tokens.issue();
    const expiresAt = tokens.expiresAt();

    await repositories.sessions.create({
      userId,
      tokenHash,
      expiresAt,
      // Truncated: this is diagnostic only, and a client controls it.
      userAgent: userAgent?.slice(0, 256),
    });

    return { token, expiresAt };
  }

  return {
    async register({ username, email, password, displayName, userAgent }) {
      // Hashing before the insert means a duplicate-username registration
      // still costs an Argon2 run, so registration cannot be used as a fast
      // username-availability oracle either.
      const passwordHash = await passwords.hash(password);

      const created = await repositories.users.create({
        username,
        // Normalised so `Ada@Example.com` and `ada@example.com` are one
        // account, matching how the unique index treats them.
        email: email.trim().toLowerCase(),
        passwordHash,
        displayName: displayName ?? username,
      });

      if (!created.ok) {
        return { ok: false, reason: created.conflict };
      }

      const session = await issueSession(created.user.id, userAgent);
      logger.info({ userId: created.user.id }, 'account registered');

      return { ok: true, user: created.user, token: session.token, expiresAt: session.expiresAt };
    },

    async login({ identifier, password, userAgent }) {
      const found = await repositories.users.findByIdentifier(identifier);

      if (found === undefined) {
        // Verify against the decoy so this path is not measurably faster.
        await passwords.verify(password, await getDecoyHash());
        return { ok: false, reason: 'invalid_credentials' };
      }

      const valid = await passwords.verify(password, found.passwordHash);
      if (!valid) {
        return { ok: false, reason: 'invalid_credentials' };
      }

      // Upgrade the stored hash if the cost parameters have since been raised.
      if (passwords.needsRehash(found.passwordHash)) {
        try {
          const upgraded = await passwords.hash(password);
          await repositories.users.updatePasswordHash(found.user.id, upgraded);
          logger.info({ userId: found.user.id }, 'password hash upgraded');
        } catch (error) {
          // A failed upgrade must not fail the login: the user's password is
          // correct and the old hash still works.
          logger.warn({ userId: found.user.id, err: error }, 'password rehash failed');
        }
      }

      const session = await issueSession(found.user.id, userAgent);
      return { ok: true, user: found.user, token: session.token, expiresAt: session.expiresAt };
    },

    async logout(sessionId) {
      // Revoked rather than deleted, so the row remains as an audit trail
      // until the cleanup job removes it after expiry.
      await repositories.sessions.revoke(sessionId);
    },

    updateProfile(userId, changes) {
      return repositories.users.updateProfile(userId, changes);
    },
  };
}
