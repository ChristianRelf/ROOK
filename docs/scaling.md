# Scaling

The path from one instance of everything to a deployment that handles serious
volume, in the order the stages should actually happen — each triggered by a
measurement rather than a guess.

**Read this first:** the section on sharding describes an *interface*, not an
implementation. What is built and what is not is stated explicitly below.

---

## Where it starts

The default deployment is one of each service and one PostgreSQL. That is the
correct configuration for a long time. A single well-indexed PostgreSQL
instance on decent hardware handles a very large amount of chat traffic, and
every stage below adds operational complexity that buys nothing until a real
limit is reached.

---

## Stage 1 — Horizontal scaling (implemented)

All three services are stateless and can be run with any number of instances
today. Nothing needs changing.

**What makes that true:**

| Concern | Why multiple instances work |
| --- | --- |
| Sessions | Rows in PostgreSQL, not process memory. Any instance validates any token. |
| Rate limits | Redis-backed, so limits are shared. An in-memory limiter would silently multiply every limit by the instance count. |
| Realtime fan-out | Events travel through Redis pub/sub, so a client on gateway A receives events produced by API instance B. |
| Outbox relay | Rows are claimed `for update skip locked`, so N gateways share the work rather than duplicating it. |
| Media jobs | Claimed from BullMQ; processing is idempotent and guarded by SQL status transitions, so two workers handed the same asset cannot corrupt it. |
| Job scheduling | BullMQ repeatable jobs, so an hourly sweep runs once across the fleet, not once per instance. |
| Recovery | Confirmed-but-unprocessed assets are found from PostgreSQL at worker startup, so a flushed queue loses no work. |

**What to watch:** `DATABASE_POOL_MAX` is per process. Multiply it by instance
count and keep the total below the server's `max_connections`. Past roughly
fifty application instances, put PgBouncer in transaction mode in front of
PostgreSQL rather than raising `max_connections` — a few hundred PostgreSQL
backends cost more in context switching than they return.

**The gateway is the instance type to scale first.** An API instance holds a
connection for milliseconds; a gateway holds a socket for hours. Memory per
instance tracks concurrent sockets, so it saturates long before the API does.

---

## Stage 2 — Read replicas

**Trigger:** read-heavy load on PostgreSQL where the primary's CPU is dominated
by `select`, and the slow-query log is mostly history reads.

Message history is overwhelmingly read-only and tolerates small staleness.
`ShardRouter` is the seam: add a `readClientFor(key)` alongside
`clientFor(key)` and route `messages.listPage` and member lists to a replica,
keeping writes and anything read-after-write on the primary.

The thing to be careful about is **read-after-write**: a client that sends a
message and immediately refetches history must not read a replica that has not
caught up, or its own message appears to vanish. In practice the send response
already returns the authoritative row, so the client has it without a refetch —
but the resync-after-reconnect path must stay on the primary, or a reconnecting
client can be told its own recent messages do not exist.

---

## Stage 3 — Time-based partitioning of `messages`

**Trigger:** the `messages` table is large enough that index maintenance and
vacuum are visible in write latency, or you need to expire old history and
`DELETE` is too expensive. Tens of millions of rows, not hundreds of thousands.

`messages` is the only table that grows without bound. UUIDv7 ids already carry
their creation timestamp, so monthly `RANGE` partitioning on `created_at` is a
natural fit, and `(channel_id, id desc)` queries continue to work with
partition pruning.

**The one schema change it requires:** a partitioned table's primary key must
include the partition key, so `primary key (id)` becomes
`primary key (id, created_at)`. That is why it is not done up front — it is a
real migration with a table rewrite, and doing it before it is needed means
paying the cost and the added operational surface for nothing.

Sketch of the migration:

```sql
-- 1. New partitioned table, PK including the partition key.
create table messages_partitioned (
  id uuid not null,
  channel_id uuid not null,
  -- ... remaining columns unchanged ...
  created_at timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);

-- 2. Partitions, created ahead of time by a scheduled job.
create table messages_2027_01 partition of messages_partitioned
  for values from ('2027-01-01') to ('2027-02-01');

-- 3. Backfill in batches, then swap under a short lock.
-- 4. Recreate the indexes per partition.
```

Once partitioned, dropping a month of history becomes `DROP TABLE` on one
partition rather than a `DELETE` that bloats the table.

---

## Stage 4 — Sharding

### What is implemented, precisely

**Implemented:** an interface. `packages/database/src/routing.ts` defines
`PartitionKey` and `ShardRouter`, and ships exactly one implementation —
`SingleShardRouter`, which returns the same database client for every key.

**Not implemented:** anything that would make sharding work. There is no
cross-shard query planner, no distributed transaction, no resharding or
backfill tooling, and no shard-aware failover. Implementing `ShardRouter`
against several databases would give you routing and nothing else.

So why does the interface exist? Because the expensive part of sharding later
is never the routing function — it is discovering that a hundred queries
silently assumed they could join across the whole dataset. Forcing every data
access to name its partition key *now*, while there is one database and being
wrong costs nothing, keeps that assumption from being made. Claiming the
interface provides sharding would be the real mistake, so it does not.

### The partition key: community id

A community's channels, messages and memberships are overwhelmingly read
together, so co-locating them keeps nearly every query single-shard.

Two things deliberately cross the boundary:

- **`users` and `sessions` are global, not community-scoped.** In a sharded
  world they belong in their own database. Authentication is a lookup by token
  hash with no community context, so it cannot be routed by community.
- **"List my communities" fans out.** It runs once per app launch, per user,
  and returns a handful of rows — the acceptable shape for a fan-out. Anything
  that fans out per *message* would not be.

### If it were ever actually needed

**Trigger:** a single PostgreSQL primary cannot absorb the write volume after
partitioning, replicas and connection pooling. This is a very high bar; most
systems that reach for sharding have an indexing problem instead.

1. Implement `ShardRouter` over a shard map (community id → shard), with the
   map itself in the global database.
2. Move `users` and `sessions` to the global database.
3. Give each shard its own outbox, with a relay per shard. Audience resolution
   already happens at write time, so fan-out needs no changes.
4. Build resharding: copy a community's rows, replay the delta, swap the map
   entry, verify, delete. This is the genuinely hard part — not the routing.

Before any of that, consider whether a second deployment serving a different
set of communities is sufficient. For most self-hosted installations it is, and
it needs none of the above.

---

## Scaling the other components

### Redis

One instance handles a great deal of pub/sub. When it stops being enough:

- Separate the **queue** Redis from the **pub/sub** Redis first. They have
  opposite characteristics — BullMQ wants persistence, fan-out wants throughput
  — and splitting them is a configuration change.
- Redis Cluster does not shard pub/sub usefully (a published message reaches
  every node), so for very wide fan-out the step is a purpose-built event bus
  (NATS, Kafka). `transportChannelFor` is the seam: it is the only place that
  decides where an event goes.

### Object storage

Already horizontally scalable, being S3-compatible. The real step is **CDN
delivery**: variants are immutable once written, so they are ideal for
long-lived caching. The change is to issue CDN URLs instead of presigned ones
in `getWithUrls`, with signed cookies or signed CDN URLs for access control.
Nothing in the messaging path is affected.

Multiple buckets (by region, or by asset class) fit behind
`ObjectStoragePort` without touching callers.

### The media worker

The easiest thing to scale: add instances. Jobs are claimed from the queue and
processing is idempotent. Image work is CPU-bound, so size instances by core
count and set `QUEUE_MEDIA_CONCURRENCY` to roughly the core count — higher just
means more jobs contending for the same CPU with more memory in flight.

---

## What to measure before each stage

| Decision | Measure |
| --- | --- |
| Add API instances | `rook_http_request_duration_seconds` p99, event-loop lag |
| Add gateway instances | `rook_realtime_connections`, memory per instance, `rook_realtime_dropped_total{reason="backpressure"}` |
| Add workers | Queue depth, `rook_media_job_duration_seconds` |
| Add PgBouncer | `pg_stat_activity` count versus `max_connections`; pool wait time |
| Add read replicas | Primary CPU split between read and write; slow-query log composition |
| Partition `messages` | `messages` table and index size; autovacuum duration; insert latency trend |
| Shard | Write throughput at the primary *after* every stage above |

The ordering matters more than any individual threshold. Each stage is cheaper
and less risky than the one after it, and skipping ahead usually means solving
the wrong problem — a missing index diagnosed as a sharding requirement.
