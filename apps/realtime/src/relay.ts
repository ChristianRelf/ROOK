import type { Redis } from 'ioredis';
import type { OutboxConfig } from '@rook/config';
import { transportChannelFor, type TransportEnvelope } from '@rook/contracts';
import { createRepositories, type DatabaseClient } from '@rook/database';
import { toLogError, type Logger, type MetricsBundle } from '@rook/observability';

/**
 * The outbox relay: moves committed events from PostgreSQL to Redis.
 *
 * This is the second half of the transactional outbox. The API writes an event
 * row in the same transaction as the change it describes; this loop claims
 * committed rows, publishes them, and marks them published.
 *
 * Why claim-publish-mark in that order, and what it does and does not
 * guarantee:
 *
 *   * Rows are claimed with `for update skip locked`, so several relay
 *     instances can run concurrently — each takes a disjoint batch instead of
 *     contending or double-publishing within a tick.
 *
 *   * The mark happens *after* a successful publish, inside the same
 *     transaction that holds the claim. If the process dies between publishing
 *     and committing the mark, the lock is released and the row is claimed
 *     again later, so the event is delivered twice.
 *
 *   * That makes delivery **at-least-once, never exactly-once.** Duplicates
 *     are the deliberate trade: losing an event is unacceptable, seeing one
 *     twice is harmless because every event is idempotent by id on the client
 *     — applying `message.created` for a message already in the store is a
 *     no-op.
 *
 * Polling rather than LISTEN/NOTIFY: NOTIFY does not survive a disconnect, so
 * a gateway that was restarting would miss the notification and the row would
 * sit unpublished until something else happened to poll. A short poll interval
 * is less clever and strictly more reliable.
 */

export interface OutboxRelay {
  start: () => void;
  stop: () => Promise<void>;
}

export function createOutboxRelay(options: {
  readonly db: DatabaseClient;
  readonly publisher: Redis;
  readonly config: OutboxConfig;
  readonly logger: Logger;
  readonly metrics: MetricsBundle;
}): OutboxRelay {
  const { db, publisher, config, logger, metrics } = options;
  const repositories = createRepositories(db);

  let running = false;
  let timer: NodeJS.Timeout | undefined;
  /** Resolves once the in-flight tick has finished, so stop() can await it. */
  let inFlight: Promise<void> = Promise.resolve();

  async function publishBatch(): Promise<number> {
    return db.transaction('outbox.relay', async (tx) => {
      const txRepositories = createRepositories(tx);
      const claimed = await txRepositories.outbox.claimBatch(tx, config.batchSize);

      if (claimed.length === 0) return 0;

      const published: typeof claimed = [];
      const failed: typeof claimed = [];

      for (const row of claimed) {
        try {
          await publishEnvelope(row.envelope);
          published.push(row);
        } catch (error) {
          // One bad event must not block the batch behind it. It stays
          // unpublished with an incremented attempt count and is retried.
          logger.error(
            { eventId: row.id, eventType: row.envelope.type, err: toLogError(error) },
            'failed to publish outbox event',
          );
          failed.push(row);
        }
      }

      await txRepositories.outbox.markPublished(
        tx,
        published.map((row) => row.id),
      );
      await txRepositories.outbox.markAttempted(
        tx,
        failed.map((row) => row.id),
      );

      for (const row of published) {
        metrics.outboxPublished.inc({ topic: row.envelope.type });
      }

      return published.length;
    });
  }

  async function publishEnvelope(envelope: TransportEnvelope): Promise<void> {
    // The audience was resolved when the event was written, so routing here is
    // a pure function of the envelope — no database access per subscriber.
    const channel = transportChannelFor(envelope.audience);
    await publisher.publish(channel, JSON.stringify(envelope));
  }

  async function tick(): Promise<void> {
    try {
      // Drain rather than publishing one batch per interval: after a burst or
      // a restart there may be a large backlog, and waiting a full interval
      // between batches would make recovery needlessly slow.
      for (;;) {
        const count = await publishBatch();
        if (count < config.batchSize) break;
        if (!running) break;
      }

      // Refreshed here rather than on a separate timer, since this is the only
      // loop that cares.
      const backlog = await repositories.outbox.backlogSize();
      metrics.outboxBacklog.set(backlog);

      if (backlog > config.batchSize * 10) {
        // A persistent backlog means realtime delivery is falling behind
        // durable writes — the clearest early signal of trouble here.
        logger.warn({ backlog }, 'outbox backlog is growing');
      }
    } catch (error) {
      // Typically Postgres or Redis being briefly unavailable. Logged and
      // retried on the next tick rather than taking the process down.
      logger.error({ err: toLogError(error) }, 'outbox relay tick failed');
    }
  }

  function schedule(): void {
    if (!running) return;

    timer = setTimeout(() => {
      inFlight = tick().finally(schedule);
    }, config.pollIntervalMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      logger.info(
        { pollIntervalMs: config.pollIntervalMs, batchSize: config.batchSize },
        'outbox relay started',
      );
      // Run immediately so a restart does not wait a full interval to drain
      // whatever accumulated while the process was down.
      inFlight = tick().finally(schedule);
    },

    async stop() {
      running = false;
      if (timer !== undefined) clearTimeout(timer);
      // Let the current tick finish so its transaction commits rather than
      // being rolled back mid-batch.
      await inFlight;
      logger.info('outbox relay stopped');
    },
  };
}

/**
 * Prunes published rows past the retention window.
 *
 * Separate from the relay loop because it runs on a much longer interval and
 * must never delay delivery.
 */
export async function pruneOutbox(options: {
  readonly db: DatabaseClient;
  readonly config: OutboxConfig;
  readonly logger: Logger;
}): Promise<number> {
  const { db, config, logger } = options;
  const cutoff = new Date(Date.now() - config.retentionSeconds * 1000);

  // Bounded per call: an unbounded delete over a large backlog would hold
  // locks and bloat WAL in one long transaction.
  const deleted = await createRepositories(db).outbox.prunePublished(cutoff, 5000);

  if (deleted > 0) {
    logger.info({ deleted, cutoff: cutoff.toISOString() }, 'pruned published outbox rows');
  }
  return deleted;
}
