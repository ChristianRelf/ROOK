import { z } from 'zod';

/**
 * Job contracts.
 *
 * Every job payload has a schema, and it is validated on the way *out* as well
 * as on the way in. That second check is the one that matters in practice: a
 * queue is a boundary between two deploys. A worker running yesterday's build
 * will be handed today's payloads, so a malformed or renamed field has to fail
 * loudly at the edge rather than halfway through processing an asset.
 *
 * Payloads carry ids, never data. The worker re-reads the asset row from
 * Postgres, which keeps jobs small and means a retry always operates on
 * current state rather than on a snapshot captured when the job was queued.
 */

export const mediaProcessJobSchema = z.object({
  assetId: z.uuid(),
  /**
   * Which attempt this is, from the producer's point of view.
   *
   * BullMQ tracks its own attempt counter; this is separate, and exists so a
   * job re-queued by the recovery sweeper (rather than by BullMQ's retry) is
   * distinguishable in logs.
   */
  requeueGeneration: z.number().int().nonnegative().default(0),
});

export type MediaProcessJob = z.infer<typeof mediaProcessJobSchema>;

/** Maintenance jobs take no payload; they derive their work from the database. */
export const maintenanceJobSchema = z.object({});
export type MaintenanceJob = z.infer<typeof maintenanceJobSchema>;

/**
 * The job registry.
 *
 * Adding a job means adding an entry here, which is what keeps `enqueue` and
 * the worker's handler map type-checked against each other — a typo in a job
 * name is a compile error, not a message that sits in Redis forever.
 */
export const jobDefinitions = {
  'media.process': mediaProcessJobSchema,
  'media.cleanupOrphans': maintenanceJobSchema,
  'sessions.cleanup': maintenanceJobSchema,
  'outbox.prune': maintenanceJobSchema,
} as const;

export type JobName = keyof typeof jobDefinitions;

export type JobPayload<Name extends JobName> = z.infer<(typeof jobDefinitions)[Name]>;

/** Input type, before schema defaults are applied. */
export type JobInput<Name extends JobName> = z.input<(typeof jobDefinitions)[Name]>;

export const jobNames = Object.keys(jobDefinitions) as JobName[];

/**
 * Jobs that run on a schedule rather than being triggered by a request.
 *
 * Cron rather than `setInterval` in the worker process: with several worker
 * instances, BullMQ's repeatable jobs ensure the sweep runs once per interval
 * across the fleet instead of once per instance.
 */
export const scheduledJobs = [
  {
    name: 'media.cleanupOrphans',
    /** Every 15 minutes: sweeps reservations the client never confirmed. */
    pattern: '*/15 * * * *',
  },
  {
    name: 'sessions.cleanup',
    /** Hourly: deletes sessions well past expiry. */
    pattern: '0 * * * *',
  },
  {
    name: 'outbox.prune',
    /** Hourly: drops published outbox rows past the retention window. */
    pattern: '30 * * * *',
  },
] as const satisfies readonly { name: JobName; pattern: string }[];
