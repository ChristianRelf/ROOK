import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import type { Pool, PoolClient } from 'pg';

/**
 * A small, explicit migration runner.
 *
 * Migrations are plain `.sql` files named `NNNN_description.sql` and applied in
 * filename order. There is no DSL and no rollback inference: a down migration,
 * if one exists, is a separate file written by hand.
 *
 * Three properties this gets right, which are the ones that matter when more
 * than one instance starts at once:
 *
 *   1. **Mutual exclusion.** A session-level advisory lock is taken before any
 *      migration runs, so two API instances booting simultaneously cannot both
 *      apply `0002`. The second waits, then finds nothing to do.
 *
 *   2. **Atomicity.** Each migration runs inside its own transaction together
 *      with the bookkeeping insert, so a failure can never record a migration
 *      as applied when it was not. Files that cannot run in a transaction
 *      (`CREATE INDEX CONCURRENTLY`, for instance) opt out with a directive.
 *
 *   3. **Immutability.** Every applied file's checksum is stored and
 *      re-verified. Editing a migration that has already run in another
 *      environment is a silent schema drift bug, so it is refused loudly here.
 */

/** Arbitrary but fixed: identifies Rook's migration lock within Postgres. */
const ADVISORY_LOCK_KEY = 0x524f_4f4b; // 'ROOK'

/** Opt out of the wrapping transaction for statements that forbid one. */
const NO_TRANSACTION_DIRECTIVE = '-- migrate:no-transaction';

const MIGRATION_FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/u;

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
  readonly runInTransaction: boolean;
}

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
  readonly durationMs: number;
}

export interface MigrationStatus {
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly MigrationFile[];
  /** Applied migrations whose file no longer matches the recorded checksum. */
  readonly drifted: readonly { version: string; name: string }[];
  /** Applied migrations with no corresponding file on disk. */
  readonly missing: readonly AppliedMigration[];
}

export interface MigratorOptions {
  readonly pool: Pool;
  readonly directory: string;
  readonly logger?: {
    info: (data: Record<string, unknown>, message: string) => void;
    warn: (data: Record<string, unknown>, message: string) => void;
  };
}

/** Stable hash of a migration's contents, used to detect edits after the fact. */
function checksumOf(sql: string): string {
  // Normalise line endings so a file checked out on Windows and on Linux
  // hashes identically. Without this, CRLF alone looks like schema drift.
  return createHash('sha256').update(sql.replace(/\r\n/gu, '\n'), 'utf8').digest('hex');
}

export async function readMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });

  const files: MigrationFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;

    const match = MIGRATION_FILENAME_PATTERN.exec(entry.name);
    if (match === null) {
      throw new Error(
        `Migration "${entry.name}" does not match NNNN_lower_snake_case.sql. ` +
          'Consistent naming is what makes ordering unambiguous.',
      );
    }

    const [, version, name] = match;
    const sql = await readFile(joinPath(directory, entry.name), 'utf8');

    files.push({
      version: version ?? '',
      name: name ?? '',
      filename: entry.name,
      sql,
      checksum: checksumOf(sql),
      runInTransaction: !sql.includes(NO_TRANSACTION_DIRECTIVE),
    });
  }

  files.sort((a, b) => a.version.localeCompare(b.version));

  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.version)) {
      throw new Error(`Duplicate migration version ${file.version}: ${file.filename}`);
    }
    seen.add(file.version);
  }

  return files;
}

async function ensureBookkeepingTable(client: PoolClient): Promise<void> {
  // Created outside the migration sequence, since it is what records the
  // sequence. `if not exists` keeps this idempotent.
  await client.query(`
    create table if not exists schema_migrations (
      version     text        primary key,
      name        text        not null,
      checksum    text        not null,
      applied_at  timestamptz not null default now(),
      duration_ms integer     not null
    )
  `);
}

async function readAppliedMigrations(client: PoolClient): Promise<AppliedMigration[]> {
  const result = await client.query<{
    version: string;
    name: string;
    checksum: string;
    applied_at: Date;
    duration_ms: number;
  }>(
    'select version, name, checksum, applied_at, duration_ms from schema_migrations order by version',
  );

  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
    durationMs: row.duration_ms,
  }));
}

export interface Migrator {
  status: () => Promise<MigrationStatus>;
  /** Applies pending migrations. Returns those applied by this call. */
  up: () => Promise<MigrationFile[]>;
}

export function createMigrator(options: MigratorOptions): Migrator {
  const { pool, directory } = options;
  const logger = options.logger;

  async function withAdvisoryLock<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      // Blocks rather than failing: a second instance should wait for the
      // first to finish, then proceed and find nothing pending.
      await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
      try {
        return await run(client);
      } finally {
        await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }

  async function computeStatus(client: PoolClient): Promise<MigrationStatus> {
    await ensureBookkeepingTable(client);

    const [files, applied] = await Promise.all([
      readMigrationFiles(directory),
      readAppliedMigrations(client),
    ]);

    const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
    const filesByVersion = new Map(files.map((file) => [file.version, file]));

    const pending = files.filter((file) => !appliedByVersion.has(file.version));

    const drifted = files
      .filter((file) => {
        const record = appliedByVersion.get(file.version);
        return record !== undefined && record.checksum !== file.checksum;
      })
      .map((file) => ({ version: file.version, name: file.name }));

    const missing = applied.filter((row) => !filesByVersion.has(row.version));

    return { applied, pending, drifted, missing };
  }

  return {
    async status() {
      return withAdvisoryLock(computeStatus);
    },

    async up() {
      return withAdvisoryLock(async (client) => {
        const status = await computeStatus(client);

        if (status.drifted.length > 0) {
          const list = status.drifted.map((m) => `${m.version}_${m.name}`).join(', ');
          throw new Error(
            `Applied migrations have been modified: ${list}. ` +
              'An already-applied migration must never be edited — other environments ' +
              'have run the old version, so the schemas have silently diverged. ' +
              'Add a new migration with the change instead.',
          );
        }

        if (status.missing.length > 0) {
          // Not fatal: this is the normal state when checking out an older
          // commit. Worth saying out loud, though.
          logger?.warn(
            { versions: status.missing.map((m) => m.version) },
            'database contains migrations with no file on disk',
          );
        }

        if (status.pending.length === 0) {
          logger?.info({ applied: status.applied.length }, 'database schema is up to date');
          return [];
        }

        const applied: MigrationFile[] = [];

        for (const migration of status.pending) {
          const started = performance.now();
          logger?.info(
            { version: migration.version, migration: migration.name },
            'applying migration',
          );

          if (migration.runInTransaction) {
            await client.query('begin');
            try {
              await client.query(migration.sql);
              await client.query(
                `insert into schema_migrations (version, name, checksum, duration_ms)
                 values ($1, $2, $3, $4)`,
                [
                  migration.version,
                  migration.name,
                  migration.checksum,
                  Math.round(performance.now() - started),
                ],
              );
              await client.query('commit');
            } catch (error) {
              await client.query('rollback');
              throw new Error(
                `Migration ${migration.filename} failed and was rolled back: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                { cause: error },
              );
            }
          } else {
            // Outside a transaction the statement and its bookkeeping cannot
            // be atomic. If the statement succeeds and the insert fails, the
            // migration is re-run next time — which is why such migrations
            // must be written idempotently.
            await client.query(migration.sql);
            await client.query(
              `insert into schema_migrations (version, name, checksum, duration_ms)
               values ($1, $2, $3, $4)`,
              [
                migration.version,
                migration.name,
                migration.checksum,
                Math.round(performance.now() - started),
              ],
            );
          }

          applied.push(migration);
          logger?.info(
            {
              version: migration.version,
              migration: migration.name,
              durationMs: Math.round(performance.now() - started),
            },
            'migration applied',
          );
        }

        return applied;
      });
    },
  };
}

export { checksumOf as migrationChecksum };
