import {
  asChannelId,
  asCommunityId,
  asEventId,
  asUserId,
  type DurableEventType,
  type EventAudience,
  type EventId,
  type ServerEvent,
  type TransportEnvelope,
  type UserId,
} from '@rook/contracts';
import { sql } from '../sql.js';
import type { Queryable } from '../pool.js';
import { newEventId } from '../ids.js';

/**
 * The transactional outbox.
 *
 * The problem it solves: a service that commits a message to Postgres and then
 * publishes to Redis has two steps that can fail independently. Crash between
 * them and the message exists but nobody is told — connected clients stay out
 * of sync with durable state until something forces a refetch. Publish first
 * instead and you can broadcast a message whose transaction then rolls back.
 *
 * The fix is to make the event part of the same transaction as the change.
 * `enqueue` writes a row using the caller's transaction handle, so the event
 * and the message commit or roll back together. A separate relay then claims
 * unpublished rows and pushes them to Redis.
 *
 * This yields at-least-once delivery, not exactly-once: the relay can publish
 * and then die before marking the row, so the event is sent twice. That is why
 * every event is idempotent by id on the client — applying `message.created`
 * for a message already present is a no-op.
 *
 * Claiming uses `for update skip locked`, which lets several relay instances
 * run concurrently: each locks a disjoint batch instead of contending or
 * duplicating work.
 */

export interface EnqueueEventInput {
  readonly type: DurableEventType;
  readonly audience: EventAudience;
  readonly payload: ServerEvent;
  /** Suppressed on this user's own connections to avoid an optimistic-UI flicker. */
  readonly originUserId?: UserId | undefined;
}

export interface OutboxRow {
  readonly id: EventId;
  readonly envelope: TransportEnvelope;
  readonly attempts: number;
}

export interface OutboxRepository {
  /**
   * Must be called with a transaction handle, inside the same transaction as
   * the change the event describes.
   */
  enqueue: (tx: Queryable, input: EnqueueEventInput) => Promise<EventId>;
  /** Locks and returns a batch of unpublished events for this relay. */
  claimBatch: (tx: Queryable, limit: number) => Promise<OutboxRow[]>;
  markPublished: (tx: Queryable, ids: readonly EventId[]) => Promise<void>;
  markAttempted: (tx: Queryable, ids: readonly EventId[]) => Promise<void>;
  /** Backlog size, exported as a gauge; the clearest "falling behind" signal. */
  backlogSize: () => Promise<number>;
  /** Prunes published rows past the retention window. */
  prunePublished: (olderThan: Date, limit: number) => Promise<number>;
}

interface RawOutboxRow {
  id: string;
  event_type: string;
  audience_scope: string;
  audience_id: string;
  origin_user_id: string | null;
  payload: ServerEvent;
  occurred_at: Date;
  attempts: number;
}

/** Rebuilds the audience discriminated union from its flattened columns. */
function toAudience(scope: string, id: string): EventAudience {
  switch (scope) {
    case 'channel':
      return { scope: 'channel', channelId: asChannelId(id) };
    case 'community':
      return { scope: 'community', communityId: asCommunityId(id) };
    case 'user':
      return { scope: 'user', userId: asUserId(id) };
    default:
      // The check constraint makes this unreachable; failing loudly beats
      // silently dropping an event with an unknown audience.
      throw new Error(`Unknown outbox audience scope "${scope}"`);
  }
}

/** The id column that a given audience is keyed by. */
function audienceId(audience: EventAudience): string {
  switch (audience.scope) {
    case 'channel':
      return audience.channelId;
    case 'community':
      return audience.communityId;
    case 'user':
      return audience.userId;
  }
}

function toEnvelope(row: RawOutboxRow): TransportEnvelope {
  return {
    id: asEventId(row.id),
    type: row.event_type as DurableEventType,
    audience: toAudience(row.audience_scope, row.audience_id),
    payload: row.payload,
    occurredAt: row.occurred_at.toISOString(),
    originUserId: row.origin_user_id === null ? null : asUserId(row.origin_user_id),
  };
}

export function createOutboxRepository(db: Queryable): OutboxRepository {
  return {
    async enqueue(tx, input) {
      const id = newEventId();

      await tx.query(
        sql`
          insert into event_outbox (
            id, event_type, audience_scope, audience_id, origin_user_id, payload
          )
          values (
            ${id},
            ${input.type},
            ${input.audience.scope},
            ${audienceId(input.audience)},
            ${input.originUserId ?? null},
            ${JSON.stringify(input.payload)}::jsonb
          )
        `,
        'outbox.enqueue',
      );

      return id;
    },

    async claimBatch(tx, limit) {
      // `skip locked` is what makes multiple relay instances safe: each claims
      // a disjoint set instead of blocking on the same head rows.
      const result = await tx.query<RawOutboxRow>(
        sql`
          select id, event_type, audience_scope, audience_id, origin_user_id,
                 payload, occurred_at, attempts
          from event_outbox
          where published_at is null
          order by id asc
          limit ${limit}
          for update skip locked
        `,
        'outbox.claimBatch',
      );

      return result.rows.map((row) => ({
        id: asEventId(row.id),
        envelope: toEnvelope(row),
        attempts: row.attempts,
      }));
    },

    async markPublished(tx, ids) {
      if (ids.length === 0) return;

      await tx.query(
        sql`
          update event_outbox
          set published_at = now()
          where id = any(${[...ids]}::uuid[])
        `,
        'outbox.markPublished',
      );
    },

    async markAttempted(tx, ids) {
      if (ids.length === 0) return;

      // Leaves published_at null so the row is retried, but records that an
      // attempt was made — a row with a high attempt count and no publish is
      // a poison event worth alerting on.
      await tx.query(
        sql`
          update event_outbox
          set attempts = attempts + 1
          where id = any(${[...ids]}::uuid[])
        `,
        'outbox.markAttempted',
      );
    },

    async backlogSize() {
      // Served entirely by the partial index on unpublished rows, so its cost
      // tracks the backlog rather than the table size.
      const result = await db.query<{ count: number }>(
        sql`select count(*)::int as count from event_outbox where published_at is null`,
        'outbox.backlogSize',
      );

      return result.rows[0]?.count ?? 0;
    },

    async prunePublished(olderThan, limit) {
      // Bounded delete: an unbounded one over a large backlog would hold
      // locks and bloat WAL in a single long transaction.
      const result = await db.query(
        sql`
          delete from event_outbox
          where id in (
            select id from event_outbox
            where published_at is not null and published_at < ${olderThan}
            order by published_at asc
            limit ${limit}
          )
        `,
        'outbox.prunePublished',
      );

      return result.rowCount;
    },
  };
}
