import { Client } from 'pg';
import { loadApiConfig } from '@rook/config';

/**
 * Global setup for the integration and e2e suites.
 *
 * Verifies the infrastructure these tests need is actually reachable, and
 * fails with instructions rather than letting every test fail with an opaque
 * connection error.
 *
 * It deliberately does *not* start Docker, run migrations or seed data. Tests
 * that silently mutate a developer's environment are how you lose local work;
 * the suite states what it needs and the developer runs it.
 */
export default async function globalSetup(): Promise<void> {
  const config = loadApiConfig();

  const problems: string[] = [];

  // --- PostgreSQL, and whether it has been migrated -----------------------
  const client = new Client({ connectionString: config.database.url });
  try {
    await client.connect();

    const result = await client.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = 'public' and table_name = 'messages'",
    );

    if (result.rows[0]?.count === '0') {
      problems.push('PostgreSQL is reachable but not migrated. Run `pnpm db:migrate`.');
    }
  } catch (error) {
    problems.push(
      `Could not connect to PostgreSQL at the configured DATABASE_URL: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }

  // --- Object storage ------------------------------------------------------
  try {
    const response = await fetch(config.storage.publicEndpoint, {
      signal: AbortSignal.timeout(3000),
    });
    // 403 is the healthy answer from a private bucket, so any reply counts.
    if (response.status >= 500) {
      problems.push(`Object storage replied ${response.status}.`);
    }
  } catch (error) {
    problems.push(
      `Could not reach object storage at ${config.storage.publicEndpoint}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      [
        '',
        'Integration tests need the local infrastructure running.',
        '',
        ...problems.map((problem) => `  - ${problem}`),
        '',
        'To fix:',
        '  pnpm infra:up      start PostgreSQL, Redis and object storage',
        '  pnpm db:migrate    apply the schema',
        '',
      ].join('\n'),
    );
  }
}
