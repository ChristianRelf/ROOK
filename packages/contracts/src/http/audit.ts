import { z } from 'zod';
import { auditActionSchema, auditLogEntrySchema } from '../entities/audit.js';
import { cursorSchema, limits } from '../primitives.js';

/** Request and response contracts for `/v1/communities/:communityId/audit-log`. */

/**
 * Cursor-paginated, newest first.
 *
 * Offset pagination would be wrong here for the usual reason and one specific
 * one: the log grows while it is being read, so page two of an offset listing
 * would repeat entries from page one. A cursor is a fixed position in the id
 * ordering, which is chronological because ids are UUIDv7.
 */
export const auditLogQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(limits.auditPageMax).default(limits.auditPageDefault),
  /**
   * Optional filters. Both narrow the query in SQL rather than the client
   * filtering a page it already fetched — otherwise filtering to a rare action
   * returns a nearly empty page and looks broken.
   */
  action: auditActionSchema.optional(),
  actorId: z.string().optional(),
});

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export const auditLogResponseSchema = z.object({
  entries: z.array(auditLogEntrySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export type AuditLogResponse = z.infer<typeof auditLogResponseSchema>;
