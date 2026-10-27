import { loadApiConfig } from '@rook/config';
import { createShutdownManager, toLogError } from '@rook/observability';
import { createMigrator, migrationsDirectory } from '@rook/database';
import { buildApp } from './app.js';
import { createAppContext } from './context.js';

/**
 * API entrypoint.
 *
 * Boot order is deliberate:
 *
 *   1. Validate configuration. A bad `.env` must fail here, not on the first
 *      request that happens to touch the missing value.
 *   2. Build the dependency graph.
 *   3. Check the schema is current. The process refuses to serve against an
 *      out-of-date schema rather than failing one query at a time in a way
 *      that looks like a bug.
 *   4. Register scheduled jobs and start listening.
 *
 * Shutdown runs in reverse: stop accepting connections, drain in-flight
 * requests, then close the pool, Redis and the queue.
 */
async function main(): Promise<void> {
  // Throws a ConfigError listing every problem at once.
  const config = loadApiConfig();
  const context = createAppContext(config);
  const { logger } = context;

  logger.info(
    {
      nodeEnv: config.runtime.nodeEnv,
      host: config.http.host,
      port: config.http.port,
    },
    'starting rook api',
  );

  const shutdown = createShutdownManager({
    logger,
    graceMs: config.runtime.shutdownGraceMs,
  });

  // Registered first so it is torn down last.
  shutdown.register({ name: 'context', run: () => context.close() });

  try {
    // Verifying rather than applying: a web process that migrates on boot
    // means N instances racing to change the schema during a rolling deploy.
    // Migrations are an explicit deployment step (`pnpm db:migrate`).
    const migrator = createMigrator({
      pool: context.db.pool,
      directory: migrationsDirectory,
      logger,
    });

    const status = await migrator.status();

    if (status.pending.length > 0) {
      throw new Error(
        `Database schema is out of date: ${status.pending.length} migration(s) pending ` +
          `(${status.pending.map((m) => m.version).join(', ')}). Run \`pnpm db:migrate\` first.`,
      );
    }
    if (status.drifted.length > 0) {
      throw new Error(
        `Applied migrations have been modified: ${status.drifted
          .map((m) => `${m.version}_${m.name}`)
          .join(', ')}. This schema no longer matches what other environments ran.`,
      );
    }

    logger.info({ applied: status.applied.length }, 'database schema verified');

    // Idempotent: every instance registers the same repeatable jobs, and
    // BullMQ ensures each interval fires once across the fleet.
    await context.queue.registerScheduledJobs();

    const app = await buildApp(context);

    shutdown.register({
      name: 'http-server',
      run: async () => {
        // Readiness flips first, so a load balancer stops sending new work
        // before the listener closes on in-flight requests.
        context.health.setShuttingDown(true);
        await app.close();
      },
    });

    await app.listen({ host: config.http.host, port: config.http.port });

    logger.info({ url: `http://${config.http.host}:${config.http.port}` }, 'rook api listening');

    shutdown.listen();
  } catch (error) {
    logger.fatal({ err: toLogError(error) }, 'failed to start');
    await context.close();
    process.exit(1);
  }
}

await main().catch((error: unknown) => {
  // Reached only when config loading itself failed, i.e. before a logger
  // exists. stderr is the only place this can usefully go.
  process.stderr.write(
    `rook-api failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
