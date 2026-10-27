#!/usr/bin/env node
import { loadMigrationConfig } from '@rook/config';
import { createLogger } from '@rook/observability';
import { createDatabaseClient } from '../pool.js';
import { createMigrator } from '../migrator.js';
import { migrationsDirectory } from '../paths.js';

/**
 * Migration CLI.
 *
 *   pnpm db:migrate          apply pending migrations
 *   pnpm db:migrate:status   show what is applied and what is pending
 *
 * Exits non-zero on failure so it can gate a deployment step. Deliberately has
 * no "drop and recreate" command: that is one keystroke away from destroying a
 * production database, and `pnpm infra:reset` already covers the local case by
 * removing the Docker volume.
 */

type Command = 'up' | 'status';

function parseCommand(argument: string | undefined): Command {
  if (argument === undefined || argument === 'up') return 'up';
  if (argument === 'status') return 'status';

  process.stderr.write(`Unknown command "${argument}". Expected "up" or "status".\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const config = loadMigrationConfig();

  const logger = createLogger({ service: 'migrate', runtime: config.runtime });
  const db = createDatabaseClient({ config: config.database, logger });
  const migrator = createMigrator({ pool: db.pool, directory: migrationsDirectory, logger });

  try {
    if (command === 'status') {
      const status = await migrator.status();

      logger.info(
        {
          applied: status.applied.length,
          pending: status.pending.map((m) => `${m.version}_${m.name}`),
          drifted: status.drifted.map((m) => `${m.version}_${m.name}`),
          missing: status.missing.map((m) => `${m.version}_${m.name}`),
        },
        'migration status',
      );

      // Drift is a correctness problem, not just information: this schema no
      // longer matches what other environments ran.
      if (status.drifted.length > 0) {
        process.exitCode = 1;
      }
      return;
    }

    const applied = await migrator.up();
    logger.info({ count: applied.length }, 'migrations complete');
  } finally {
    await db.close();
  }
}

await main().catch((error: unknown) => {
  // Written to stderr rather than logged, because a config failure happens
  // before the logger exists and this path must still say something useful.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
