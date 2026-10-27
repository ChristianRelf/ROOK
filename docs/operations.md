# Operations

Running Rook: what to watch, how to deploy, and what each signal means.

---

## Endpoints

Every service exposes the same three.

### `GET /health/live`

"Is this process broken and in need of a restart?" Consults **no** dependency.
Returns 200 while running, 503 once shutdown has begun.

Wire this to a container liveness probe. Deliberately dependency-free: if a
database check were included here, a brief PostgreSQL blip would restart every
instance at once, turning a degraded minute into a cold-start stampede.

### `GET /health/ready`

"Should this instance receive traffic?" Consults dependencies concurrently,
each with its own timeout.

| Status | Meaning | HTTP |
| --- | --- | --- |
| `healthy` | Everything responding | 200 |
| `degraded` | A non-critical dependency is down | 200 |
| `unhealthy` | A critical dependency is down, or shutting down | 503 |

`degraded` still serves traffic on purpose. Which dependencies count as
critical differs by service, and the difference is intentional:

| Service | Critical | Non-critical |
| --- | --- | --- |
| api | PostgreSQL | Redis, object storage |
| realtime | PostgreSQL, Redis | --- |
| media-worker | PostgreSQL, object storage | --- |

Redis is non-critical in the API because losing it costs rate limiting and
typing indicators; taking every instance out of rotation over that is a worse
outage than the degradation. It *is* critical in the gateway, because without
it the gateway has no events to deliver.

### `GET /metrics`

Prometheus text format. **Unauthenticated**, so it must be reachable only from
inside the deployment network -- exposing it publicly leaks request volumes and
error rates.

---

## Metrics worth alerting on

| Metric | Watch for | Why it matters |
| --- | --- | --- |
| `rook_outbox_backlog` | Sustained growth | **The most important signal.** Realtime delivery is falling behind durable writes: messages are being saved but not delivered. |
| `rook_http_request_duration_seconds` | p99 rising | Usually database contention or pool exhaustion. |
| `rook_realtime_dropped_total{reason="backpressure"}` | Any sustained rate | Clients cannot keep up, or the gateway is overloaded. |
| `rook_realtime_dropped_total{reason="rate_limit"}` | Spikes | A misbehaving or hostile client. |
| `rook_realtime_connections{state="open"}` | Approaching instance capacity | Time to add a gateway. |
| `rook_media_jobs_total{outcome="failed"}` | Rising | Either bad uploads (expected, bounded) or a broken worker (not). |
| `rook_database_query_duration_seconds` | p99 by operation | Points at the specific query, since operations are named. |
| `nodejs_eventloop_lag_seconds` | Above ~100 ms | Something CPU-bound is blocking the loop. |

Suggested starting thresholds:

```yaml
- alert: OutboxBacklogGrowing
  expr: rook_outbox_backlog > 1000
  for: 5m

- alert: RealtimeBackpressure
  expr: rate(rook_realtime_dropped_total{reason="backpressure"}[5m]) > 1
  for: 10m

- alert: MediaJobsFailing
  expr: rate(rook_media_jobs_total{outcome="failed"}[15m]) > 0.5
  for: 15m

- alert: ApiLatency
  expr: histogram_quantile(0.99, rate(rook_http_request_duration_seconds_bucket[5m])) > 1
  for: 10m
```

---

## Deployment

### Order

```text
1. pnpm db:migrate         explicit step, before any new code starts
2. deploy media-worker     tolerates old and new schema
3. deploy realtime         gateways, rolling
4. deploy api              last, so clients never reach an un-migrated schema
```

**Migrations are never run by a starting service.** The API verifies the schema
is current at boot and refuses to start otherwise, but applies nothing.
Migrating on boot means N instances racing to change the schema during a
rolling deploy.

The migrator takes a session-level advisory lock, so running it concurrently is
safe: the second invocation waits, then finds nothing pending.

### Backwards-compatible migrations

Old and new code run simultaneously during a rolling deploy, so:

- Adding a nullable column, or one with a default, is safe.
- Dropping or renaming a column needs two deploys: stop reading it, then drop
  it.
- A migration that rewrites a large table needs `CREATE INDEX CONCURRENTLY`
  and the `-- migrate:no-transaction` directive. Such migrations must be
  written idempotently, because the statement and its bookkeeping cannot be
  atomic outside a transaction.

### Shutdown

Every service drains on SIGTERM:

1. Readiness flips to unhealthy, so load balancers stop sending work.
2. New work is refused (listener closed, queue paused).
3. In-flight work finishes, up to `SHUTDOWN_GRACE_SECONDS`.
4. The pool, Redis connections and queue close.

Set the orchestrator's termination grace period **above**
`SHUTDOWN_GRACE_SECONDS`, or the process is killed mid-drain.

A hard deadline sits over the whole sequence: if a hook hangs, the process
exits non-zero anyway rather than lingering until it is killed.

---

## Configuration

Validated at startup. A missing or malformed value aborts the process with
every problem listed at once, rather than failing on the first request that
happens to touch it.

Each service validates **only the sections it uses**: the media worker does not
need `REALTIME_PORT`, and the gateway needs no S3 credentials. That keeps the
blast radius of a bad deploy smaller.

Values that must change for production:

| Variable | Why |
| --- | --- |
| `SESSION_TOKEN_PEPPER` | `openssl rand -base64 48`. Rotating it invalidates every session. |
| `POSTGRES_PASSWORD` | The compose default is public. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Same. |
| `CORS_ALLOWED_ORIGINS` | Exact origins. Never `*`. |
| `NODE_ENV=production` | Enables HSTS and proxy-header trust. |
| `LOG_PRETTY=false` | Keeps logs machine-readable. |
| `DATABASE_SSL=true` | For any managed PostgreSQL. |

---

## Capacity notes

**Connection pools.** `DATABASE_POOL_MAX` is per process. Multiply by instance
count and keep the total under `max_connections`. Past roughly fifty instances,
use PgBouncer in transaction mode rather than raising `max_connections`.

**Gateway memory** tracks concurrent sockets. `REALTIME_MAX_BUFFERED_BYTES`
(1 MiB default) caps per-connection outbound buffering, so worst-case memory is
bounded by `connections x 1 MiB` regardless of how slow the slowest client is.

**Worker concurrency.** `QUEUE_MEDIA_CONCURRENCY` should be about the core
count. Image processing is CPU-bound; higher just means more jobs contending
for the same CPU with more memory in flight.

---

## Backups

PostgreSQL is the only thing that must be backed up. Everything in Redis is
rebuildable from it, and object storage should use the provider's own
replication.

```bash
pg_dump --format=custom --no-owner "$DATABASE_URL" > rook-$(date +%F).dump
```

What a restore must account for: object storage and PostgreSQL are separate
systems, so restoring the database to an earlier point leaves media rows whose
objects may be newer, and objects with no row. The orphan sweeper handles the
latter; the former surfaces as an asset that cannot be fetched.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Messages save but do not appear live | Relay stopped, or Redis unreachable. Check `rook_outbox_backlog` and the gateway's readiness. |
| Clients reconnect in a loop | Check the close code. 4001 means the token is rejected; 4003 means a client build is too old. |
| Uploads fail at the PUT | Storage CORS does not allow the client origin, or the presigned URL expired (`MEDIA_UPLOAD_URL_TTL_SECONDS`). |
| Uploads confirm but never become ready | No worker running, or jobs failing. Check the worker's logs and `rook_media_jobs_total`. |
| `413` on a send | Body over the 256 KiB limit. Attachments do not go through here, so something is sending a very large JSON body. |
| API refuses to start, mentioning migrations | `pnpm db:migrate` has not been run, or a migration file was edited after being applied. |
| Everything slow, latency rising together | Pool exhaustion. Compare `pg_stat_activity` against pool size x instance count. |
