# 0003 -- Transactional outbox for event delivery

**Status:** accepted
**Date:** 2026-10-27

## Context

A message must be persisted *and* delivered to connected clients. The naive
implementation does them in sequence:

```ts
await db.insertMessage(message);
await redis.publish(channel, message);   // separate failure domain
```

Those two steps fail independently, and both orderings are broken:

- **Persist then publish:** crash in between and the message exists but nobody
  is told. Connected clients stay silently out of sync with durable state until
  something forces a refetch -- which, for a client that is already connected
  and idle, may be never.
- **Publish then persist:** the transaction can roll back after the broadcast,
  so clients render a message that does not exist. Worse than losing it,
  because it looks correct.

Two-phase commit across PostgreSQL and Redis would be correct and is not
seriously an option at this scale.

## Decision

Write the event to an `event_outbox` table **in the same transaction as the
change it describes**. A separate relay then claims committed rows, publishes
them to Redis, and marks them published.

```ts
await db.transaction(async (tx) => {
  const message = await messages.send(tx, input);   // the row
  await events.messageCreated(tx, message);         // the event
});                                                 // both, or neither
```

## Why

Atomicity comes free: the event and the row are the same transaction, so a
committed change always has its event and a rolled-back one never produces
one. There is no window to crash in.

Claiming uses `for update skip locked`, which means several relay instances can
run concurrently -- each takes a disjoint batch rather than contending or
double-publishing within a tick. That is what lets the relay live inside the
gateway process and scale with it, instead of being a singleton that needs its
own leader election.

Polling, rather than `LISTEN/NOTIFY`: a notification does not survive a
disconnect, so a gateway that happened to be restarting would miss it and the
row would sit unpublished until something else polled. A 250 ms poll is less
clever and strictly more reliable.

## Consequences

**Delivery is at-least-once, never exactly-once.** The relay can publish and
then die before committing the mark, so the event is delivered twice. This is
the deliberate trade: losing an event is unacceptable, seeing one twice is
harmless, because every event is idempotent by id and the client keys messages
by id. Applying `message.created` for a message already in the store is a
no-op.

Exactly-once would require distributed consensus between the relay and Redis
for no practical benefit.

**Added latency.** Delivery includes up to `OUTBOX_POLL_INTERVAL_MS` of
polling delay. Measured end-to-end delivery was around 150 ms, which is well
inside what feels instant in a chat client.

**An extra table that grows.** Published rows are pruned hourly past the
retention window. The read path uses a partial index on unpublished rows only,
so the relay's query cost tracks the backlog rather than the table size.

**A new operational signal, and a good one.** `rook_outbox_backlog` is the
clearest indicator that realtime delivery is falling behind durable writes --
a condition that, without the outbox, would be invisible until users noticed.

**Ephemeral events bypass it entirely.** Typing indicators publish straight to
Redis. Routing them through the outbox would mean a durable write per
keystroke; they are worthless seconds later and nobody minds losing one.

## Alternatives considered

- **Publish inside the transaction** -- does not help. The publish is not
  transactional, so it can succeed and the transaction still roll back.
- **Change data capture (Debezium, `wal2json`)** -- removes the application's
  responsibility entirely and is a good answer at larger scale, but it adds a
  Kafka-class dependency and couples the event schema to the table schema.
- **A durable queue instead of pub/sub** (Redis Streams, BullMQ) -- would give
  per-consumer cursors and replay. Worth revisiting if per-client replay is
  ever needed, but the HTTP resync path already covers gap recovery with no
  additional infrastructure.
