import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { loadMediaWorkerConfig } from '@rook/config';
import {
  createHealthRegistry,
  createLogger,
  createMetrics,
  createShutdownManager,
  renderMetrics,
} from '@rook/observability';
import { createDatabaseClient, createRepositories, sql } from '@rook/database';
import { createImageProcessor, createS3Storage } from '@rook/media';
import { createEventPublisher } from '@rook/messaging';
import { createQueue, createWorker } from '@rook/queue';
import type { MediaAssetId } from '@rook/contracts';
import { processAsset } from './process-asset.js';
import {
  cleanupExpiredSessions,
  cleanupOrphanedUploads,
  pruneOutbox,
  recoverPendingAssets,
} from './maintenance.js';

/**
 * The media worker.
 *
 * Runs image processing and the scheduled housekeeping jobs. Separate from the
 * API for two reasons that both matter in production:
 *
 *   1. Image decoding is CPU-bound and memory-hungry. In the API process it
 *      would block the event loop and make every request slow while a large
 *      photo is resized.
 *
 *   2. They scale differently. A burst of uploads needs more workers; a burst
 *      of messages needs more API instances. Separate processes let you add
 *      the one you actually need.
 *
 * Several workers may run concurrently: jobs are claimed from BullMQ, and the
 * processing itself is idempotent and guarded by status transitions in SQL, so
 * two workers handed the same asset cannot corrupt it.
 */
async function main(): Promise<void> {
  const config = loadMediaWorkerConfig();
  const instanceId = process.env['INSTANCE_ID'] ?? randomUUID().slice(0, 8);

  const logger = createLogger({
    service: 'media-worker',
    runtime: config.runtime,
    bindings: { instanceId },
  });

  const metrics = createMetrics({ service: 'media-worker' });
  const health = createHealthRegistry();

  logger.info({ concurrency: config.queue.mediaConcurrency, instanceId }, 'starting media worker');

  const db = createDatabaseClient({
    config: config.database,
    logger,
    onQueryDuration: (operation, seconds) =>
      metrics.databaseQueryDuration.observe({ operation }, seconds),
  });

  const repositories = createRepositories(db);
  const storage = createS3Storage({ config: config.storage, logger });
  const processor = createImageProcessor(config.media);
  const events = createEventPublisher(repositories.outbox);

  const queue = createQueue({ redis: config.redis, queue: config.queue, logger });

  health.register({
    name: 'postgres',
    critical: true,
    timeoutMs: 2000,
    run: async () => {
      await db.query(sql`select 1`, 'health.postgres');
    },
  });

  health.register({
    name: 'object-storage',
    critical: true,
    timeoutMs: 3000,
    // Critical here: a worker that cannot reach storage cannot do its only job.
    run: async () => {
      await storage.head('health/probe');
    },
  });

  const worker = createWorker({
    redis: config.redis,
    queue: config.queue,
    logger,
    onJobComplete: (name, outcome) => {
      if (name === 'media.process') metrics.mediaJobs.inc({ outcome });
    },
    handlers: {
      'media.process': async (job) => {
        await processAsset(
          job.payload.assetId as MediaAssetId,
          { current: job.attempt, isFinal: job.isFinalAttempt },
          { db, storage, processor, events, config: config.media, logger, metrics },
        );
      },

      'media.cleanupOrphans': async () => {
        await cleanupOrphanedUploads({ db, storage, config: config.media, logger });
      },

      'sessions.cleanup': async () => {
        await cleanupExpiredSessions({ db, logger });
      },

      'outbox.prune': async () => {
        await pruneOutbox({ db, logger, retentionSeconds: config.outbox.retentionSeconds });
      },
    },
  });

  // --- Crash recovery ------------------------------------------------------
  //
  // Redis is not the only copy of anything important. Assets confirmed but not
  // processed are recovered from PostgreSQL, so a flushed queue loses no work.
  await recoverPendingAssets({
    db,
    logger,
    enqueue: async (assetId) => {
      await queue.enqueue('media.process', { assetId }, { deduplicationId: assetId });
    },
  });

  // --- Health endpoint -----------------------------------------------------
  //
  // The worker serves no application traffic, but it still needs to be
  // observable: without this an orchestrator cannot tell a wedged worker from
  // an idle one.
  const httpServer = createServer((request, response) => {
    const url = request.url ?? '/';

    const respond = (status: number, body: unknown, contentType = 'application/json'): void => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      response.writeHead(status, {
        'content-type': contentType,
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    };

    if (url === '/health/live') {
      const report = health.liveness();
      respond(report.status === 'healthy' ? 200 : 503, report);
      return;
    }

    if (url === '/health/ready') {
      void health
        .readiness()
        .then((report) => respond(report.status === 'unhealthy' ? 503 : 200, report))
        .catch(() => respond(503, { status: 'unhealthy' }));
      return;
    }

    if (url === '/metrics') {
      void renderMetrics(metrics.registry)
        .then(({ contentType, body }) => respond(200, body, contentType))
        .catch(() => respond(500, { error: 'metrics unavailable' }));
      return;
    }

    respond(404, { error: { code: 'not_found', message: 'That endpoint does not exist.' } });
  });

  const healthPort = Number(process.env['WORKER_HEALTH_PORT'] ?? 4002);

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(healthPort, '127.0.0.1', () => resolve());
  });

  // --- Lifecycle -----------------------------------------------------------
  const shutdown = createShutdownManager({ logger, graceMs: config.runtime.shutdownGraceMs });

  shutdown.register({
    name: 'infrastructure',
    run: async () => {
      await queue.close();
      await db.close();
    },
  });

  shutdown.register({
    name: 'queue-worker',
    run: async () => {
      health.setShuttingDown(true);
      // Stops taking new jobs, then waits for in-flight ones. A job killed
      // mid-flight would be retried anyway, but finishing cleanly avoids the
      // duplicate work.
      await worker.pause();
      await worker.close();
    },
  });

  shutdown.register({
    name: 'health-server',
    run: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      }),
  });

  logger.info({ healthPort }, 'media worker ready');
  shutdown.listen();
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `rook-media-worker failed to start: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(1);
});
