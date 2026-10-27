# Decision records

One file per decision that is expensive to reverse, or surprising enough to
need justifying. Each records the context at the time, the choice, and what it
costs -- so a future change is an informed one rather than a rediscovery.

Not every choice gets a record. These are the ones where the reasoning is not
obvious from the code.

| # | Decision |
| --- | --- |
| [0001](0001-typescript-version.md) | TypeScript 6, not 7 |
| [0002](0002-object-storage-choice.md) | SeaweedFS for local object storage |
| [0003](0003-transactional-outbox.md) | Transactional outbox for event delivery |
| [0004](0004-bearer-sessions.md) | Bearer tokens over cookies |
| [0005](0005-sql-without-orm.md) | Hand-written SQL, no ORM |
| [0006](0006-http-send-socket-receive.md) | Send over HTTP, receive over WebSocket |
