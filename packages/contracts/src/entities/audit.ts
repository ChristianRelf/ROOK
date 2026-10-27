import { z } from 'zod';
import { auditEntryIdSchema, communityIdSchema, userIdSchema } from '../ids.js';
import { isoTimestampSchema } from '../primitives.js';

/**
 * The community audit log.
 *
 * Append-only, and recorded server-side by the service that performs the
 * action rather than by the route or the client. That placement is the whole
 * point: an entry is written in the same transaction as the change it
 * describes, so there is no path that mutates a community without logging it
 * and no path that logs a change which then rolls back.
 *
 * Actions are a closed enum rather than free text. A client has to render each
 * one as a sentence, and an unrecognised action would render as nothing — so
 * adding one is a deliberate contract change that the client is updated for.
 */

export const auditActionSchema = z.enum([
  'community.updated',

  'channel.created',
  'channel.updated',
  'channel.deleted',

  'category.created',
  'category.updated',
  'category.deleted',

  'member.joined',
  'member.role_changed',
  'member.removed',

  'invite.created',
  'invite.revoked',
]);

export type AuditAction = z.infer<typeof auditActionSchema>;

/** What an entry points at, so a client can label it without guessing. */
export const auditTargetTypeSchema = z.enum([
  'community',
  'channel',
  'category',
  'member',
  'invite',
]);

export type AuditTargetType = z.infer<typeof auditTargetTypeSchema>;

export const auditLogEntrySchema = z.object({
  id: auditEntryIdSchema,
  communityId: communityIdSchema,
  /**
   * Null once the acting account has been deleted. `actorLabel` is a snapshot
   * taken when the entry was written, so the log stays readable afterwards —
   * and stays accurate if the actor later renames themselves.
   */
  actorId: userIdSchema.nullable(),
  actorLabel: z.string(),

  action: auditActionSchema,
  targetType: auditTargetTypeSchema,
  /** Null for actions whose target has no id, and kept after the target is gone. */
  targetId: z.string().nullable(),
  targetLabel: z.string().nullable(),

  /**
   * Action-specific detail, e.g. `{ from: 'member', to: 'admin' }`.
   *
   * Loosely typed on purpose. The set of actions grows, and a discriminated
   * union per action would make every addition a breaking change for a client
   * that only wants to show a sentence and a timestamp.
   */
  metadata: z.record(z.string(), z.unknown()),

  createdAt: isoTimestampSchema,
});

export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;
