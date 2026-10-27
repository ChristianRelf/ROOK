import type { CommunityId } from '@rook/contracts';
import type { DatabaseClient } from './pool.js';

/**
 * Partition routing — an interface, and honestly only an interface.
 *
 * **What is implemented:** a single PostgreSQL deployment. `SingleShardRouter`
 * returns the one database client for every key. Nothing in this file splits
 * data across machines.
 *
 * **What is not implemented:** actual sharding. There is no cross-shard query
 * planner, no distributed transaction, no resharding or backfill tooling, and
 * no shard-aware connection failover. Implementing this interface against
 * several databases would give you routing and nothing else.
 *
 * Why it exists at all: the value is in forcing every data access to name its
 * partition key *now*, while there is one database and the cost of being
 * wrong is zero. The expensive part of sharding later is never the routing
 * function — it is discovering that a hundred queries silently assumed they
 * could join across the whole dataset. Routing through this interface keeps
 * that assumption from being made.
 *
 * The chosen key is **community id**. A community's channels, messages and
 * memberships are overwhelmingly read together, so co-locating them keeps
 * almost every query single-shard. The two things that cross community
 * boundaries are deliberate and small:
 *
 *   - `users` and `sessions` are global, not community-scoped. In a sharded
 *     world these belong in their own database, not in a community shard.
 *   - "List my communities" fans out across shards. It is a once-per-launch,
 *     per-user query returning a handful of rows, which is the acceptable
 *     shape for a fan-out.
 *
 * See docs/scaling.md for the staged path and the measurements that should
 * trigger each stage.
 */

/** The partition key for community-scoped data. */
export interface CommunityPartitionKey {
  readonly kind: 'community';
  readonly communityId: CommunityId;
}

/** Data with no community scope: users, sessions, global lookups. */
export interface GlobalPartitionKey {
  readonly kind: 'global';
}

export type PartitionKey = CommunityPartitionKey | GlobalPartitionKey;

export const globalPartition: GlobalPartitionKey = { kind: 'global' };

export function communityPartition(communityId: CommunityId): CommunityPartitionKey {
  return { kind: 'community', communityId };
}

export interface ShardRouter {
  /** The client that owns the data for `key`. */
  clientFor: (key: PartitionKey) => DatabaseClient;
  /**
   * Every distinct client, for operations that genuinely must span shards —
   * the outbox relay, migrations, health checks.
   *
   * Deliberately awkward to use: a fan-out should be a conscious decision, so
   * it reads as one at the call site.
   */
  allClients: () => readonly DatabaseClient[];
  /** Names the shard for `key`, for logging and metrics labels. */
  shardNameFor: (key: PartitionKey) => string;
}

/**
 * The only implementation that exists: one database for everything.
 *
 * This is the correct configuration until measurements say otherwise. A single
 * well-indexed Postgres instance handles a very large amount of chat traffic,
 * and adding shards earlier buys operational complexity with no return.
 */
export class SingleShardRouter implements ShardRouter {
  constructor(private readonly client: DatabaseClient) {}

  clientFor(_key: PartitionKey): DatabaseClient {
    return this.client;
  }

  allClients(): readonly DatabaseClient[] {
    return [this.client];
  }

  shardNameFor(_key: PartitionKey): string {
    return 'primary';
  }
}
