import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Test layout, split into three projects so each can be run on its own:
 *
 *   unit         pure domain logic, no infrastructure. Always runnable.
 *   integration  needs Postgres + Redis + S3 from docker-compose.
 *   e2e          drives the API and realtime gateway end to end.
 *
 * `pnpm test` runs only the unit project, so a clone with no Docker running
 * still gets a meaningful signal. CI runs all three.
 */

const packageNames = [
  'auth',
  'config',
  'contracts',
  'database',
  'media',
  'messaging',
  'observability',
  'queue',
  'ui',
] as const;

/**
 * Resolve workspace imports to TypeScript source rather than built output, so
 * tests never run against a stale `dist`.
 */
const workspaceAliases = Object.fromEntries(
  packageNames.map((name) => [
    `@rook/${name}`,
    fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
  ]),
);

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    projects: [
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'apps/*/src/**/*.test.ts',
            'services/*/src/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          // Infrastructure-backed tests share a database, so they run serially
          // within a file and are given room to wait on container startup.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
          globalSetup: ['tests/integration/setup/global-setup.ts'],
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: 'e2e',
          environment: 'node',
          include: ['tests/e2e/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 90_000,
          globalSetup: ['tests/integration/setup/global-setup.ts'],
        },
      },
    ],
  },
});
