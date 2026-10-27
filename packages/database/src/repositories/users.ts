import type { CurrentUser, MediaAssetId, PublicUser, UserId } from '@rook/contracts';
import { raw, sql } from '../sql.js';
import type { Queryable } from '../pool.js';
import { newUserId } from '../ids.js';
import { isUniqueViolation } from '../errors.js';
import { columns, toCurrentUser, toPublicUser, type UserRow } from '../internal/rows.js';

/**
 * User persistence.
 *
 * The repository deals in storage concerns only: it stores a password hash and
 * never computes one. Hashing and verification live in `@rook/auth`, which
 * keeps the cryptography in a module with no database dependency and lets it
 * be tested without one.
 */

/** Distinguishes which unique index rejected an insert. */
export type CreateUserConflict = 'username_taken' | 'email_taken';

export interface CreateUserInput {
  readonly username: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
}

export type CreateUserResult =
  | { readonly ok: true; readonly user: CurrentUser }
  | { readonly ok: false; readonly conflict: CreateUserConflict };

export interface UserWithCredentials {
  readonly user: CurrentUser;
  readonly passwordHash: string;
}

export interface UserRepository {
  create: (input: CreateUserInput) => Promise<CreateUserResult>;
  findById: (id: UserId) => Promise<CurrentUser | undefined>;
  findPublicById: (id: UserId) => Promise<PublicUser | undefined>;
  /** Looks up by username or email for login. Returns the hash to verify against. */
  findByIdentifier: (identifier: string) => Promise<UserWithCredentials | undefined>;
  updateProfile: (
    id: UserId,
    changes: { displayName?: string; avatarAssetId?: MediaAssetId | null },
  ) => Promise<CurrentUser | undefined>;
  /**
   * Replaces the stored hash.
   *
   * Used for opportunistic rehashing when the Argon2 cost parameters have been
   * raised: a correct login upgrades the hash in place, so tightening the
   * configuration actually reaches existing accounts.
   */
  updatePasswordHash: (id: UserId, passwordHash: string) => Promise<boolean>;
}

export function createUserRepository(db: Queryable): UserRepository {
  return {
    async create(input) {
      const id = newUserId();

      try {
        const result = await db.query<UserRow>(
          sql`
            insert into users as u (id, username, email, password_hash, display_name)
            values (${id}, ${input.username}, ${input.email}, ${input.passwordHash}, ${input.displayName})
            returning ${raw(columns.user)}
          `,
          'users.create',
        );

        const row = result.rows[0];
        if (row === undefined) {
          throw new Error('insert into users returned no row');
        }
        return { ok: true, user: toCurrentUser(row) };
      } catch (error) {
        // Let the unique indexes arbitrate rather than checking first.
        // A pre-check is a race: two concurrent registrations for the same
        // username both see "available" and both proceed.
        if (isUniqueViolation(error, 'users_username_key')) {
          return { ok: false, conflict: 'username_taken' };
        }
        if (isUniqueViolation(error, 'users_email_key')) {
          return { ok: false, conflict: 'email_taken' };
        }
        throw error;
      }
    },

    async findById(id) {
      const result = await db.query<UserRow>(
        sql`select ${raw(columns.user)} from users u where u.id = ${id}`,
        'users.findById',
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toCurrentUser(row);
    },

    async findPublicById(id) {
      const result = await db.query<UserRow>(
        sql`select ${raw(columns.user)} from users u where u.id = ${id}`,
        'users.findPublicById',
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toPublicUser(row);
    },

    async findByIdentifier(identifier) {
      // Both columns store a normalised lowercase value, so lowering the
      // input is enough — no case-insensitive index needed.
      const normalised = identifier.trim().toLowerCase();

      const result = await db.query<UserRow & { password_hash: string }>(
        sql`
          select ${raw(columns.user)}, u.password_hash
          from users u
          where u.username = ${normalised} or u.email = ${normalised}
          limit 1
        `,
        'users.findByIdentifier',
      );

      const row = result.rows[0];
      if (row === undefined) return undefined;

      return { user: toCurrentUser(row), passwordHash: row.password_hash };
    },

    async updateProfile(id, changes) {
      // `coalesce` with an explicit null-marker parameter keeps this a single
      // statement while still distinguishing "leave unchanged" from "set to
      // null". The avatar case needs that distinction: undefined means leave
      // it, null means clear it.
      const clearAvatar = changes.avatarAssetId === null;

      const result = await db.query<UserRow>(
        sql`
          update users u
          set
            display_name = coalesce(${changes.displayName ?? null}, u.display_name),
            avatar_asset_id = case
              when ${clearAvatar}::boolean then null
              else coalesce(${changes.avatarAssetId ?? null}::uuid, u.avatar_asset_id)
            end,
            updated_at = now()
          where u.id = ${id}
          returning ${raw(columns.user)}
        `,
        'users.updateProfile',
      );

      const row = result.rows[0];
      return row === undefined ? undefined : toCurrentUser(row);
    },

    async updatePasswordHash(id, passwordHash) {
      const result = await db.query(
        sql`
          update users
          set password_hash = ${passwordHash}, updated_at = now()
          where id = ${id}
        `,
        'users.updatePasswordHash',
      );

      return result.rowCount > 0;
    },
  };
}
