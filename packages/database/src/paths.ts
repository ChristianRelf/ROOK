import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Filesystem location of the migration files.
 *
 * Resolved relative to this module rather than to `process.cwd()`, because the
 * migrator is invoked from several working directories: the repo root via
 * `pnpm db:migrate`, the package directory directly, and from an integration
 * test. A cwd-relative path works in exactly one of those.
 *
 * Migrations live in `packages/database/migrations` — next to the repositories
 * that depend on the schema, rather than under `infrastructure/`, so a change
 * to a query and the index it needs sit in one reviewable commit.
 */
const thisDir = dirname(fileURLToPath(import.meta.url));

// `src/` during development (tsx) and `dist/` once built; both are one level
// below the package root.
export const migrationsDirectory: string = resolve(thisDir, '..', 'migrations');
