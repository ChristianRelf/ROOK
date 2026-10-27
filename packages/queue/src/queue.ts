import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { QueueConfig, RedisConfig } from '@rook/config';
import { toLogError, type Logger } from '@rook/observability';
import {
  jobDefinitions,
  scheduledJobs,
  type JobInput,
  type JobName,
  type JobPayload,
} from './jobs.js';

/**
 * Queue and worker, on BullMQ.
 *
 * The ports below are narrow on purpose. Application code sees `enqueue` and a
 * handler map and nothing else — no BullMQ `Job`, no Redis connection, no
 * retry configuration. Swapping to SQS or pg-boss later means reimplementing
 * this file, not touching the API or the worker's business logic.
 *
 * Retry policy is set here rather than per call site, so every job gets
 * bounded exponential backoff by default and nobody has to remember to ask
 * for it.
 */

/** What application code uses to enqueue work. */
export interface QueuePort {
  enqueue: <Name extends JobName>(
    name: Name,
    payload: JobInput<Name>,
    options?: EnqueueOptions,
  ) => Promise<string>;
  /** Registers the repeatable maintenance jobs. Idempotent. */
  registerScheduledJobs: () => Promise<void>;
  close: () => Promise<void>;
}

export interface EnqueueOptions {
  /**
   * Collapses duplicates: enqueuing the same id twice while the first is still
   * pending is a no-op.
   *
   * Used for `media.process`, where the asset id is the natural key — a
   * confirm retried by the client should not queue the same work twice.
   */
  readonly deduplicationId?: string;
  readonly delayMs?: number;
  /** Lower numbers run first. Defaults to normal priority. */
  readonly priority?: number;
}

/** What a job handler receives. Deliberately not BullMQ's `Job`. */
export interface JobContext<Name extends JobName> {
  readonly name: Name;
  readonly id: string;
  readonly payload: JobPayload<Name>;
  /** BullMQ's attempt counter, 1 on the first run. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** True on the final attempt, so a handler can record permanent failure. */
  readonly isFinalAttempt: boolean;
}

export type JobHandler<Name extends JobName> = (context: JobContext<Name>) => Promise<void>;

export type JobHandlers = {
  readonly [Name in JobName]?: JobHandler<Name>;
};

/** The single BullMQ queue name; jobs are distinguished by their job name. */
const QUEUE_NAME = 'rook';

function connectionFor(redis: RedisConfig): ConnectionOptions {
  return {
    url: redis.url,
    // BullMQ requires this for blocking commands used by workers.
    maxRetriesPerRequest: null,
  };
}

export function createQueue(options: {
  readonly redis: RedisConfig;
  readonly queue: QueueConfig;
  readonly logger: Logger;
}): QueuePort {
  const { redis, queue: queueConfig, logger } = options;

  const queue = new Queue(QUEUE_NAME, {
    connection: connectionFor(redis),
    prefix: queueConfig.prefix,
    defaultJobOptions: {
      attempts: queueConfig.jobAttempts,
      backoff: { type: 'exponential', delay: queueConfig.jobBackoffMs },
      // Keep a bounded history: enough to investigate a failure, not enough
      // to grow Redis without limit.
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86_400, count: 5000 },
    },
  });

  return {
    async enqueue(name, payload, enqueueOptions) {
      // Validated before it reaches Redis: a bad payload should fail in the
      // request that caused it, not in a worker minutes later where the only
      // evidence is a stack trace with no context.
      const parsed = jobDefinitions[name].parse(payload);

      const job = await queue.add(name, parsed, {
        ...(enqueueOptions?.deduplicationId !== undefined
          ? { deduplication: { id: `${name}:${enqueueOptions.deduplicationId}` } }
          : {}),
        ...(enqueueOptions?.delayMs !== undefined ? { delay: enqueueOptions.delayMs } : {}),
        ...(enqueueOptions?.priority !== undefined ? { priority: enqueueOptions.priority } : {}),
      });

      logger.debug({ job: name, jobId: job.id }, 'job enqueued');
      return job.id ?? '';
    },

    async registerScheduledJobs() {
      for (const scheduled of scheduledJobs) {
        // upsertJobScheduler is idempotent, so every instance can call this on
        // boot without creating duplicate schedules.
        await queue.upsertJobScheduler(
          scheduled.name,
          { pattern: scheduled.pattern },
          { name: scheduled.name, data: {} },
        );
        logger.debug(
          { job: scheduled.name, pattern: scheduled.pattern },
          'scheduled job registered',
        );
      }
    },

    async close() {
      await queue.close();
    },
  };
}

export interface WorkerPort {
  close: () => Promise<void>;
  /** Stops taking new jobs but lets in-flight ones finish. */
  pause: () => Promise<void>;
}

export function createWorker(options: {
  readonly redis: RedisConfig;
  readonly queue: QueueConfig;
  readonly logger: Logger;
  readonly handlers: JobHandlers;
  readonly onJobComplete?: (name: JobName, outcome: 'completed' | 'failed') => void;
}): WorkerPort {
  const { redis, queue: queueConfig, logger, handlers, onJobComplete } = options;

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const name = job.name as JobName;
      const handler = handlers[name] as JobHandler<JobName> | undefined;

      if (handler === undefined) {
        // An unknown job name means a producer is ahead of this worker build.
        // Failing is correct: silently dropping it would lose the work.
        throw new Error(
          `No handler registered for job "${name}". This worker build may be older than the producer.`,
        );
      }

      // Validated on the way in as well as out, because the payload may have
      // been written by a different deploy.
      const parseResult = jobDefinitions[name].safeParse(job.data);
      if (!parseResult.success) {
        throw new Error(
          `Job "${name}" payload failed validation: ${parseResult.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
        );
      }

      const maxAttempts = job.opts.attempts ?? queueConfig.jobAttempts;

      await handler({
        name,
        id: job.id ?? '',
        payload: parseResult.data,
        attempt: job.attemptsMade + 1,
        maxAttempts,
        isFinalAttempt: job.attemptsMade + 1 >= maxAttempts,
      });
    },
    {
      connection: connectionFor(redis),
      prefix: queueConfig.prefix,
      concurrency: queueConfig.mediaConcurrency,
    },
  );

  worker.on('completed', (job) => {
    logger.debug({ job: job.name, jobId: job.id }, 'job completed');
    onJobComplete?.(job.name as JobName, 'completed');
  });

  worker.on('failed', (job, error) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts.attempts ?? queueConfig.jobAttempts;
    const willRetry = attemptsMade < maxAttempts;

    // Distinguished in the log because they need different responses: a retry
    // is noise, an exhausted job is work that was dropped.
    logger[willRetry ? 'warn' : 'error'](
      {
        job: job?.name,
        jobId: job?.id,
        attempt: attemptsMade,
        maxAttempts,
        willRetry,
        err: toLogError(error),
      },
      willRetry ? 'job failed; will retry' : 'job failed permanently',
    );

    if (!willRetry && job !== undefined) {
      onJobComplete?.(job.name as JobName, 'failed');
    }
  });

  worker.on('error', (error) => {
    // Connection-level problems, not job failures. An unhandled 'error' event
    // would take the process down.
    logger.error({ err: toLogError(error) }, 'queue worker error');
  });

  return {
    pause: () => worker.pause(),
    close: () => worker.close(),
  };
}
