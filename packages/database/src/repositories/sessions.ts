import { asSessionId, asUserId, type SessionId, type UserId } from '@rook/contracts';
import { raw, sql } from '../sql.js';
import type { Queryable } from '../pool.js';
import { newSessionId } from '../ids.js';
import { columns, toCurrentUser, type UserRow } from '../internal/rows.js';
import type { CurrentUser } from '@rook/contracts';

/**
 * Session persistence.
 *
 * Sessions are rows in Postgres rather than self-contained signed tokens. That
 * is the whole point: a JWT cannot be revoked before it expires, so "log out
 * everywhere" and "lock this account now" become impossible to honour. A row
 * can simply be marked revoked, and the next request fails.
 *
 * The cost is a database read per authenticated request. That read is a single
 * primary-key-style lookup on a unique index, and the API caches the resolved
 * session in Redis for a short window, so it does not dominate.
 *
 * Only the hash of (pepper || token) is stored. The repository never sees the
 * raw token — `@rook/auth` hashes before calling in — so a database dump
 * yields nothing usable without the pepper from the environment.
 */

export interface CreateSessionInput {
  readonly userId: UserId;
  /** SHA-256 of pepper + token, computed by `@rook/auth`. */
  readonly tokenHash: Buffer;
  readonly expiresAt: Date;
  readonly userAgent?: string | undefined;
}

export interface SessionRecord {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
}

/** A validated session together with the user it belongs to. */
export interface AuthenticatedSession {
  readonly session: SessionRecord;
  readonly user: CurrentUser;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date;
}

/** How stale `last_seen_at` may get before it is worth a write. */
const LAST_SEEN_REFRESH_MS = 60_000;

export interface SessionRepository {
  create: (input: CreateSessionInput) => Promise<SessionRecord>;
  /**
   * Resolves a token hash to its session and user in one query, ignoring
   * expired and revoked rows.
   */
  findActiveByTokenHash: (tokenHash: Buffer) => Promise<AuthenticatedSession | undefined>;
  revoke: (id: SessionId) => Promise<boolean>;
  revokeAllForUser: (userId: UserId) => Promise<number>;
  /** Best-effort activity timestamp; skipped when recently updated. */
  touch: (id: SessionId, now?: Date) => Promise<void>;
  /** Deletes rows well past expiry. Returns how many were removed. */
  deleteExpired: (olderThan: Date) => Promise<number>;
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: asSessionId(row.id),
    userId: asUserId(row.user_id),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function createSessionRepository(db: Queryable): SessionRepository {
  return {
    async create(input) {
      const id = newSessionId();

      const result = await db.query<SessionRow>(
        sql`
          insert into sessions as s (id, user_id, token_hash, expires_at, user_agent)
          values (${id}, ${input.userId}, ${input.tokenHash}, ${input.expiresAt}, ${
            input.userAgent ?? null
          })
          returning s.id, s.user_id, s.created_at, s.expires_at, s.last_seen_at
        `,
        'sessions.create',
      );

      const row = result.rows[0];
      if (row === undefined) {
        throw new Error('insert into sessions returned no row');
      }
      return toSessionRecord(row);
    },

    async findActiveByTokenHash(tokenHash) {
      // One join rather than two queries: every authenticated request runs
      // this, so halving its round trips matters.
      //
      // The session columns are aliased, and that is not cosmetic. `sessions`
      // and `users` both have an `id`, and the driver returns one flat object
      // per row — so an unaliased `s.id, ..., u.id` silently resolves `id` to
      // whichever came last. That made every session carry the *user's* id,
      // which in turn made logout revoke a session that did not exist and left
      // the token working. Aliasing is what keeps the two apart.
      const result = await db.query<
        UserRow & {
          session_id: string;
          session_user_id: string;
          session_created_at: Date;
          session_expires_at: Date;
          session_last_seen_at: Date;
        }
      >(
        sql`
          select
            s.id           as session_id,
            s.user_id      as session_user_id,
            s.created_at   as session_created_at,
            s.expires_at   as session_expires_at,
            s.last_seen_at as session_last_seen_at,
            ${raw(columns.user)}
          from sessions s
          join users u on u.id = s.user_id
          where s.token_hash = ${tokenHash}
            and s.revoked_at is null
            and s.expires_at > now()
          limit 1
        `,
        'sessions.findActiveByTokenHash',
      );

      const row = result.rows[0];
      if (row === undefined) return undefined;

      return {
        session: toSessionRecord({
          id: row.session_id,
          user_id: row.session_user_id,
          created_at: row.session_created_at,
          expires_at: row.session_expires_at,
          last_seen_at: row.session_last_seen_at,
        }),
        // Reads `u.*` from the aliased user columns, where `id` is the user's.
        user: toCurrentUser(row),
      };
    },

    async revoke(id) {
      const result = await db.query(
        sql`
          update sessions
          set revoked_at = now()
          where id = ${id} and revoked_at is null
        `,
        'sessions.revoke',
      );
      return result.rowCount > 0;
    },

    async revokeAllForUser(userId) {
      const result = await db.query(
        sql`
          update sessions
          set revoked_at = now()
          where user_id = ${userId} and revoked_at is null
        `,
        'sessions.revokeAllForUser',
      );
      return result.rowCount;
    },

    async touch(id, now = new Date()) {
      // Guarded by the staleness window so a chatty client does not generate
      // a write per request. Dead rows from frequent updates are a real cost
      // on a table read this often.
      const threshold = new Date(now.getTime() - LAST_SEEN_REFRESH_MS);

      await db.query(
        sql`
          update sessions
          set last_seen_at = ${now}
          where id = ${id} and last_seen_at < ${threshold}
        `,
        'sessions.touch',
      );
    },

    async deleteExpired(olderThan) {
      const result = await db.query(
        sql`delete from sessions where expires_at < ${olderThan}`,
        'sessions.deleteExpired',
      );
      return result.rowCount;
    },
  };
}
