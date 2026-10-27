/**
 * `@rook/queue` — asynchronous job contracts and the BullMQ-backed transport.
 *
 * Application code depends on `QueuePort` and `JobHandlers`, never on BullMQ
 * directly, so the transport can be replaced without touching callers.
 */

export {
  jobDefinitions,
  jobNames,
  scheduledJobs,
  mediaProcessJobSchema,
  maintenanceJobSchema,
  type JobName,
  type JobPayload,
  type JobInput,
  type MediaProcessJob,
  type MaintenanceJob,
} from './jobs.js';

export {
  createQueue,
  createWorker,
  type QueuePort,
  type WorkerPort,
  type EnqueueOptions,
  type JobContext,
  type JobHandler,
  type JobHandlers,
} from './queue.js';
