import type { MediaConfig } from '@rook/config';
import { createRepositories, type DatabaseClient } from '@rook/database';
import type { ObjectStoragePort } from '@rook/media';
import { toLogError, type Logger } from '@rook/observability';

/**
 * Scheduled housekeeping.
 *
 * All three jobs below exist because every pipeline leaks something, and the
 * leaks are only visible months later as disk use nobody can account for:
 *
 *   * **Orphaned uploads.** A client asks for an upload URL and never
 *     confirms — it crashed, the user navigated away, the network dropped.
 *     The reservation row and possibly the object stay behind for ever.
 *
 *   * **Expired sessions.** Rows are kept past expiry as an audit trail, but
 *     not indefinitely.
 *
 *   * **Published outbox rows.** Kept briefly for debugging, then pruned. The
 *     partial index means a backlog query stays fast regardless, but the table
 *     itself would grow without bound.
 *
 * Each is bounded per run and idempotent, so a missed run is caught up by the
 * next one and a repeated run is harmless.
 */

/** Rows touched per run, so one sweep cannot hold locks for long. */
const SWEEP_LIMIT = 500;

export async function cleanupOrphanedUploads(options: {
  readonly db: DatabaseClient;
  readonly storage: ObjectStoragePort;
  readonly config: MediaConfig;
  readonly logger: Logger;
}): Promise<{ deleted: number; skipped: number }> {
  const { db, storage, config, logger } = options;
  const repositories = createRepositories(db);

  const cutoff = new Date(Date.now() - config.orphanCleanupAfterSeconds * 1000);
  const stale = await repositories.media.listStaleReservations(cutoff, SWEEP_LIMIT);

  let deleted = 0;
  let skipped = 0;

  for (const asset of stale) {
    // Checked even though a `reserved` asset should not be referenced: the
    // cost of being wrong here is deleting an image out of someone's message.
    const unreferenced = await repositories.media.isUnreferenced(asset.id);
    if (!unreferenced) {
      logger.warn({ assetId: asset.id }, 'reserved asset is referenced; leaving it alone');
      skipped += 1;
      continue;
    }

    try {
      // Storage first, then the row. If this crashes in between, the row is
      // still `reserved` and the next sweep retries — whereas deleting the row
      // first would lose the key and leak the object permanently.
      await storage.delete(asset.storageKey);
      await repositories.media.deleteById(asset.id);
      deleted += 1;
    } catch (error) {
      // Left for the next run rather than failing the whole sweep.
      logger.warn(
        { assetId: asset.id, err: toLogError(error) },
        'could not clean up orphaned upload',
      );
      skipped += 1;
    }
  }

  if (deleted > 0 || skipped > 0) {
    logger.info(
      { deleted, skipped, cutoff: cutoff.toISOString() },
      'swept orphaned upload reservations',
    );
  }

  return { deleted, skipped };
}

export async function cleanupExpiredSessions(options: {
  readonly db: DatabaseClient;
  readonly logger: Logger;
  /** Grace period past expiry before a row is actually deleted. */
  readonly graceSeconds?: number;
}): Promise<number> {
  const { db, logger } = options;

  // Kept for a while past expiry, so a recently expired session is still
  // visible when investigating "why was I logged out".
  const graceSeconds = options.graceSeconds ?? 7 * 24 * 60 * 60;
  const cutoff = new Date(Date.now() - graceSeconds * 1000);
  const deleted = await createRepositories(db).sessions.deleteExpired(cutoff);

  if (deleted > 0) {
    logger.info({ deleted, cutoff: cutoff.toISOString() }, 'deleted expired sessions');
  }
  return deleted;
}

export async function pruneOutbox(options: {
  readonly db: DatabaseClient;
  readonly logger: Logger;
  readonly retentionSeconds: number;
}): Promise<number> {
  const { db, logger, retentionSeconds } = options;

  const cutoff = new Date(Date.now() - retentionSeconds * 1000);
  const deleted = await createRepositories(db).outbox.prunePublished(cutoff, 5000);

  if (deleted > 0) {
    logger.info({ deleted, cutoff: cutoff.toISOString() }, 'pruned published outbox rows');
  }
  return deleted;
}

/**
 * Re-queues assets that are confirmed but still unprocessed.
 *
 * Run once at startup. The queue lives in Redis, which is explicitly not the
 * only copy of anything important — so if Redis was flushed, or jobs were lost
 * while every worker was down, the work is recovered from PostgreSQL instead of
 * being silently dropped. This is what makes the `uploaded` status meaningful
 * rather than just a label.
 */
export async function recoverPendingAssets(options: {
  readonly db: DatabaseClient;
  readonly logger: Logger;
  readonly enqueue: (assetId: string) => Promise<void>;
}): Promise<number> {
  const { db, logger, enqueue } = options;

  const pending = await createRepositories(db).media.listPendingProcessing(SWEEP_LIMIT);
  if (pending.length === 0) return 0;

  let requeued = 0;
  for (const asset of pending) {
    try {
      // Deduplicated on the asset id, so this is a no-op when the job is
      // already queued — the common case when a single worker restarts.
      await enqueue(asset.id);
      requeued += 1;
    } catch (error) {
      logger.warn(
        { assetId: asset.id, err: toLogError(error) },
        'could not re-queue pending asset',
      );
    }
  }

  logger.info({ requeued, found: pending.length }, 'recovered assets awaiting processing');
  return requeued;
}
