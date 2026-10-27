import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config as loadDotenvFile } from 'dotenv';

/**
 * Loads the repository-root `.env` during development.
 *
 * Services run from their own package directory, so a plain `dotenv.config()`
 * would look in the wrong place. We walk up to the workspace root instead,
 * which means one `.env` serves every service.
 *
 * Existing `process.env` values always win, so a value exported in the shell
 * or injected by the container runtime is never overwritten by the file. In
 * production there is usually no `.env` at all and this is a no-op.
 */

let loaded = false;

/** Walks up from `startDir` looking for the workspace root marker. */
function findWorkspaceRoot(startDir: string): string | undefined {
  let current = resolve(startDir);

  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export interface LoadDotenvResult {
  /** Absolute path of the file that was read, if any. */
  readonly path: string | undefined;
  readonly loaded: boolean;
}

/**
 * Idempotent: safe to call from every service entrypoint, and from tests that
 * run several services in one process.
 */
export function loadDotenv(options: { cwd?: string; force?: boolean } = {}): LoadDotenvResult {
  if (loaded && options.force !== true) {
    return { path: undefined, loaded: false };
  }

  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  if (root === undefined) {
    loaded = true;
    return { path: undefined, loaded: false };
  }

  // NODE_ENV-specific files win over the shared one, matching the convention
  // most tooling already follows.
  const candidates =
    process.env['NODE_ENV'] === undefined ? ['.env'] : [`.env.${process.env['NODE_ENV']}`, '.env'];

  for (const candidate of candidates) {
    const path = join(root, candidate);
    if (!existsSync(path)) continue;

    const result = loadDotenvFile({ path, override: false, quiet: true });
    if (result.error !== undefined) {
      throw new Error(`Failed to read ${path}: ${result.error.message}`);
    }
    loaded = true;
    return { path, loaded: true };
  }

  loaded = true;
  return { path: undefined, loaded: false };
}

/** Test seam: lets a test re-run loading against a different directory. */
export function resetDotenvForTesting(): void {
  loaded = false;
}
