import type {
  AuditAction,
  AuditLogEntry,
  AuditTargetType,
  CommunityId,
  UserId,
} from '@rook/contracts';
import { empty, raw, sql } from '../sql.js';
import type { Queryable } from '../pool.js';
import { newAuditEntryId } from '../ids.js';
import { encodeCursor } from '../cursor.js';
import { columns, toAuditLogEntry, type AuditLogEntryRow } from '../internal/rows.js';

/**
 * Audit log persistence.
 *
 * There is no `update` and no `delete` here, and that is the design rather than
 * an omission: a log an administrator can rewrite is not a record of anything.
 * Rows age out only through the community being deleted, which cascades.
 *
 * `append` takes a `Queryable` so it can be called with a transaction handle.
 * Every caller does, because an audit entry has to commit with the change it
 * describes — otherwise a failed role change can leave a log entry claiming it
 * happened, or a successful one can go unrecorded.
 */

export interface AppendAuditInput {
  readonly communityId: CommunityId;
  /** Null only for an action taken by the system rather than a person. */
  readonly actorId: UserId | null;
  /** Snapshot of the actor's display name, so the entry survives a rename. */
  readonly actorLabel: string;
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  readonly targetId?: string | null | undefined;
  readonly targetLabel?: string | null | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface AuditLogPage {
  readonly entries: AuditLogEntry[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface AuditRepository {
  /** Must be called with the transaction that performs the change. */
  append: (tx: Queryable, input: AppendAuditInput) => Promise<void>;
  listPage: (
    communityId: CommunityId,
    options: {
      cursorId?: string | undefined;
      limit: number;
      action?: AuditAction | undefined;
      actorId?: string | undefined;
    },
  ) => Promise<AuditLogPage>;
}

export function createAuditRepository(db: Queryable): AuditRepository {
  return {
    async append(tx, input) {
      await tx.query(
        sql`
          insert into audit_log_entries (
            id, community_id, actor_id, actor_label, action,
            target_type, target_id, target_label, metadata
          )
          values (
            ${newAuditEntryId()},
            ${input.communityId},
            ${input.actorId},
            -- Truncated to the column limit rather than rejected: a display
            -- name that is somehow too long must not be able to block a
            -- legitimate administrative action.
            ${input.actorLabel.slice(0, 64)},
            ${input.action},
            ${input.targetType},
            ${input.targetId ?? null},
            ${
              input.targetLabel === null || input.targetLabel === undefined
                ? null
                : input.targetLabel.slice(0, 128)
            },
            ${JSON.stringify(input.metadata ?? {})}::jsonb
          )
        `,
        'audit.append',
      );
    },

    async listPage(communityId, options) {
      // One row beyond the limit, so `hasMore` costs nothing extra — the same
      // trick used for message history and member pages.
      const fetchLimit = options.limit + 1;

      // Newest first, so the cursor walks backwards through ids. Ids are
      // UUIDv7, so id order is creation order and no timestamp comparison is
      // needed in the index.
      const cursorFilter =
        options.cursorId === undefined ? empty : sql`and al.id < ${options.cursorId}`;

      const actionFilter =
        options.action === undefined ? empty : sql`and al.action = ${options.action}`;

      const actorFilter =
        options.actorId === undefined ? empty : sql`and al.actor_id = ${options.actorId}`;

      const result = await db.query<AuditLogEntryRow>(
        sql`
          select ${raw(columns.auditEntry)}
          from audit_log_entries al
          where al.community_id = ${communityId}
          ${cursorFilter}
          ${actionFilter}
          ${actorFilter}
          order by al.id desc
          limit ${fetchLimit}
        `,
        'audit.listPage',
      );

      const hasMore = result.rows.length > options.limit;
      const page = hasMore ? result.rows.slice(0, options.limit) : result.rows;
      const last = page[page.length - 1];

      return {
        entries: page.map(toAuditLogEntry),
        nextCursor: hasMore && last !== undefined ? encodeCursor(last.id) : null,
        hasMore,
      };
    },
  };
}
