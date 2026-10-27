import type { MediaAssetId } from '@rook/contracts';
import type { MediaConfig } from '@rook/config';
import {
  createRepositories,
  storageKeyFor,
  type DatabaseClient,
  type VariantInput,
} from '@rook/database';
import {
  ObjectTooLargeError,
  UnprocessableImageError,
  type ImageProcessorPort,
  type ObjectStoragePort,
} from '@rook/media';
import type { EventPublisher } from '@rook/messaging';
import { toLogError, type Logger, type MetricsBundle } from '@rook/observability';

/**
 * Processing one media asset: download, validate, derive variants, record.
 *
 * The job is **idempotent**, which is what makes it safe to retry and safe to
 * deliver twice:
 *
 *   * It re-reads the asset row rather than trusting the payload, so a retry
 *     always works from current state.
 *   * An asset already `ready` returns immediately.
 *   * Variants are written with `on conflict do update`, so a re-run
 *     overwrites its own previous output instead of failing.
 *   * Variant storage keys are derived from the asset id, so a re-upload
 *     replaces the same object rather than leaving an orphan behind.
 *
 * Failures are split into two kinds, and the distinction is the important part:
 *
 *   * **Permanent** (`UnprocessableImageError`): the bytes are not a usable
 *     image. Retrying cannot help, so the asset is marked `failed` with a
 *     reason the user can see and the job returns successfully — a job that
 *     keeps retrying a corrupt file is just noise that hides real failures.
 *
 *   * **Transient** (anything else — storage unreachable, database blip): the
 *     error is rethrown so the queue retries with backoff. On the final
 *     attempt the asset is marked `failed` so it does not sit in `uploaded`
 *     for ever, looking like it is still being worked on.
 */

export interface ProcessAssetDependencies {
  readonly db: DatabaseClient;
  readonly storage: ObjectStoragePort;
  readonly processor: ImageProcessorPort;
  readonly events: EventPublisher;
  readonly config: MediaConfig;
  readonly logger: Logger;
  readonly metrics: MetricsBundle;
}

export type ProcessOutcome = 'processed' | 'already_ready' | 'missing' | 'failed_permanently';

export async function processAsset(
  assetId: MediaAssetId,
  attempt: { current: number; isFinal: boolean },
  deps: ProcessAssetDependencies,
): Promise<ProcessOutcome> {
  const { db, storage, processor, events, config, logger, metrics } = deps;
  const repositories = createRepositories(db);
  const log = logger.child({ assetId, attempt: attempt.current });

  const details = await repositories.media.findProcessingDetails(assetId);
  if (details === undefined) {
    // The asset row is gone — most likely swept as an orphan. Nothing to do,
    // and failing would only retry a job whose subject no longer exists.
    log.warn('asset no longer exists; dropping job');
    metrics.mediaJobs.inc({ outcome: 'skipped' });
    return 'missing';
  }

  const current = await repositories.media.findById(assetId);
  if (current?.status === 'ready') {
    // A duplicate delivery of an already-completed job.
    log.debug('asset is already ready; nothing to do');
    metrics.mediaJobs.inc({ outcome: 'skipped' });
    return 'already_ready';
  }

  const started = performance.now();
  await repositories.media.incrementAttempts(assetId);

  try {
    // Bounded read: the limit is enforced while streaming, so an object larger
    // than its recorded size cannot exhaust the worker's heap.
    const bytes = await storage.getBytes(details.storageKey, config.maxUploadBytes);

    // Verifies the format from magic bytes, enforces the pixel and dimension
    // guards, and re-encodes every variant from decoded pixels (which is what
    // strips EXIF, including GPS).
    const processed = await processor.process(bytes);

    // Variants are uploaded before the row is marked ready, so a `ready`
    // asset always has its objects present. The opposite order would let a
    // client request a thumbnail that does not exist yet.
    const variants: VariantInput[] = [];
    for (const variant of processed.variants) {
      const key = storageKeyFor(assetId, variant.name);

      await storage.put({
        key,
        body: variant.body,
        contentType: variant.contentType,
      });

      variants.push({
        name: variant.name,
        storageKey: key,
        contentType: variant.contentType,
        width: variant.width,
        height: variant.height,
        byteSize: variant.byteSize,
      });

      metrics.mediaJobDuration.observe(
        { variant: variant.name },
        (performance.now() - started) / 1000,
      );
    }

    // The status change and its notification commit together, so a client is
    // never told an asset is ready before the row says so.
    await db.transaction('media.markReady', async (tx) => {
      const txRepositories = createRepositories(tx);

      const updated = await txRepositories.media.markReady(assetId, {
        contentType: processed.contentType,
        byteSize: processed.byteSize,
        width: processed.width,
        height: processed.height,
        variants,
      });

      if (!updated) {
        // Another worker finished first. Its event is already queued.
        log.debug('asset was marked ready concurrently');
        return;
      }

      const asset = await txRepositories.media.findById(assetId);
      if (asset !== undefined) {
        await events.mediaUpdated(tx, asset);
      }
    });

    log.info(
      {
        contentType: processed.contentType,
        width: processed.width,
        height: processed.height,
        variants: variants.length,
        durationMs: Math.round(performance.now() - started),
      },
      'asset processed',
    );

    metrics.mediaJobs.inc({ outcome: 'completed' });
    return 'processed';
  } catch (error) {
    const permanent =
      error instanceof UnprocessableImageError || error instanceof ObjectTooLargeError;

    if (permanent) {
      // The message is written to be shown to the user, and the error types
      // above are constructed with that in mind — no stack, no storage key.
      const reason = error.message;

      await db.transaction('media.markFailed', async (tx) => {
        const txRepositories = createRepositories(tx);
        const marked = await txRepositories.media.markFailed(assetId, reason);

        if (marked) {
          const asset = await txRepositories.media.findById(assetId);
          if (asset !== undefined) {
            // The client is waiting on a thumbnail, so it has to be told the
            // upload failed rather than left spinning.
            await events.mediaUpdated(tx, asset);
          }
        }
      });

      // Deleting the unusable original keeps rejected uploads from
      // accumulating in the bucket.
      try {
        await storage.delete(details.storageKey);
      } catch (deleteError) {
        log.warn({ err: toLogError(deleteError) }, 'could not delete rejected original');
      }

      log.info({ reason }, 'asset rejected permanently');
      metrics.mediaJobs.inc({ outcome: 'failed' });

      // Returned, not thrown: the job did its work, which was to decide that
      // these bytes are unusable. Throwing would schedule a pointless retry.
      return 'failed_permanently';
    }

    // Transient. Mark failed only once retries are exhausted, so the asset
    // does not linger in `uploaded` looking like work still in progress.
    if (attempt.isFinal) {
      log.error(
        { err: toLogError(error) },
        'asset processing failed on the final attempt; marking failed',
      );

      await db.transaction('media.markFailedFinal', async (tx) => {
        const txRepositories = createRepositories(tx);
        const marked = await txRepositories.media.markFailed(
          assetId,
          'processing failed; please try uploading again',
        );
        if (marked) {
          const asset = await txRepositories.media.findById(assetId);
          if (asset !== undefined) await events.mediaUpdated(tx, asset);
        }
      });

      metrics.mediaJobs.inc({ outcome: 'failed' });
    } else {
      metrics.mediaJobs.inc({ outcome: 'retried' });
    }

    // Rethrown so BullMQ applies its backoff and retry policy.
    throw error;
  }
}
