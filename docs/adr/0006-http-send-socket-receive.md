# 0006 -- Send over HTTP, receive over WebSocket

**Status:** accepted
**Date:** 2026-10-27

## Context

With a WebSocket already open for delivery, it is tempting to send messages
over it too: one connection, less overhead per message, no HTTP handshake.

## Decision

Messages are sent with `POST /v1/channels/:id/messages`. The socket carries
only inbound frames that are connection-scoped (`identify`, `heartbeat`,
`subscribe`, `unsubscribe`) plus typing indicators.

## Why

A send is a request that needs an answer, and the answer has structure:

- It can fail validation, with field-level detail.
- It can be refused by authorisation.
- It can be rate limited, with a retry-after.
- It can be a **retry of an earlier attempt whose response was lost** -- which
  is precisely when the client does not know whether the first one landed.
- On success it returns the authoritative row, so the client replaces its
  optimistic copy with the real id and server timestamp rather than guessing.

HTTP expresses all of that already: status codes, one error envelope, an
idempotency key, a response body. Over a socket each one has to be reinvented
-- correlation ids to match replies to requests, an ad-hoc error frame, a
bespoke retry protocol. That is building request/response inside a protocol
that deliberately has none.

Two further benefits fall out of the split:

**Sends keep working while the socket is down.** The connection banner says so
explicitly ("You can still send messages; new ones may be delayed"). If sends
went over the socket, a dropped connection would leave a read-only client.

**The gateway has no write path.** Every inbound frame is connection management
or ephemeral, so there is nothing there to authorise against the database and
nothing to validate for persistence. That is a materially smaller attack
surface on the component holding thousands of long-lived connections.

Typing indicators are the exception, and they prove the rule: fire-and-forget,
no acknowledgement, never persisted -- so there is nothing HTTP would add.

## Consequences

- An HTTP request per message rather than a frame. Negligible with keep-alive,
  and chat volume per client is low.
- Two client modules (an API client and a socket client), which honestly
  reflects two different concerns rather than duplicating one.
- The client needs its own idempotency-key retry logic, since the server
  cannot push a "your send failed" frame. That logic lives in the message
  store and is unit tested.

## Alternatives considered

- **Send over the socket with correlation ids** -- works, and is what Discord
  does. Rejected because it means reimplementing status codes, validation
  errors and retry semantics inside the frame protocol, and because losing the
  ability to send while reconnecting is a real downgrade for the user.
- **Both** -- the worst option: two write paths to keep in step, with
  authorisation and idempotency duplicated across them and certain to drift.
