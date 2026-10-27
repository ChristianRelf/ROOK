# Rook

A modular, self-hostable communication platform: a Tauri desktop client over a
TypeScript backend, built so the pieces can be deployed and scaled
independently.

This is a **foundation release**. It proves the architecture end to end --
registration, communities, channels, persisted messaging with realtime
delivery, and an asynchronous media pipeline -- rather than covering a broad
feature set. [docs/limitations.md](docs/limitations.md) lists exactly what is
and is not implemented; read it before planning work on top of this.

---

## Requirements

| Tool    | Version         | Notes                                |
| ------- | --------------- | ------------------------------------ |
| Node.js | >= 22.12        | Tested on 24.15                      |
| pnpm    | >= 9.15         | `corepack enable pnpm`               |
| Docker  | with Compose v2 | PostgreSQL, Redis and object storage |
| Rust    | >= 1.77         | Only needed to run the desktop shell |

The desktop app additionally needs the platform's webview toolchain --
see [Tauri's prerequisites](https://tauri.app/start/prerequisites/). On Linux
that is `libwebkit2gtk`; on Windows, the Edge WebView2 runtime (already present
on Windows 10/11); on macOS, Xcode command line tools.

---

## Setup

```bash
git clone <repository-url> rook
cd rook

pnpm install
cp .env.example .env     # works as-is for local development

pnpm infra:up            # PostgreSQL, Redis, object storage
pnpm db:migrate          # create the schema
pnpm db:seed             # optional: two accounts and a community
```

Then start the backend services:

```bash
pnpm dev                 # API, realtime gateway and media worker
```

and in a second terminal, the desktop app:

```bash
pnpm desktop:tauri       # the real desktop window
# or
pnpm dev:desktop         # the frontend in a browser at http://localhost:1420
```

Register an account in the app, create a community, create a channel, and send
a message. To see realtime delivery, sign in as a second account -- either
register another, or use the seeded ones:

| Username | Password                  |
| -------- | ------------------------- |
| `ada`    | `rook-dev-password-ada`   |
| `grace`  | `rook-dev-password-grace` |

`pnpm db:seed` prints the community's join code.

### If a port is already in use

`docker compose up` fails with `port is already allocated` when something else
holds 5432, 6379 or 8333. Change the port in `.env` (`POSTGRES_PORT`,
`REDIS_PORT`, `S3_PORT`) **and** the matching URL (`DATABASE_URL`,
`REDIS_URL`, `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`) -- Compose reads the former
and the application reads the latter, so both have to agree.

On Windows, also avoid the ranges `netsh int ipv4 show excludedportrange
protocol=tcp` reports: Hyper-V reserves them and a bind there fails with a
permissions error rather than "in use".

### Running it for real

The steps above are for local development. To host it so other people can
connect -- the whole backend in Docker behind a Cloudflare tunnel, with no port
forwarding -- see **[docs/self-hosting.md](docs/self-hosting.md)**.

The desktop client ships with a default server address but exposes a **Change
server** field on the sign-in screen, so a binary is not tied to one
deployment.

---

## What runs where

| Service                 | Port | Purpose                                                              |
| ----------------------- | ---- | -------------------------------------------------------------------- |
| `apps/api`              | 4000 | HTTP API: auth, communities, channels, messages, media authorisation |
| `apps/realtime`         | 4001 | WebSocket gateway, and the outbox relay                              |
| `services/media-worker` | 4002 | Image processing and scheduled housekeeping (health only)            |
| `apps/desktop`          | 1420 | Vite dev server for the frontend                                     |
| PostgreSQL              | 5432 | Source of truth                                                      |
| Redis                   | 6379 | Cache, presence, rate limits, job queue, event fan-out               |
| Object storage          | 8333 | S3-compatible (SeaweedFS locally)                                    |

Every service exposes `/health/live`, `/health/ready` and `/metrics`.

---

## Commands

```bash
# Development
pnpm dev                 # all backend services, one terminal
pnpm dev:api             # just the API
pnpm dev:realtime        # just the gateway
pnpm dev:worker          # just the media worker
pnpm dev:desktop         # frontend in a browser
pnpm desktop:tauri       # frontend in the desktop shell

# Database
pnpm db:migrate          # apply pending migrations
pnpm db:migrate:status   # what is applied, pending or drifted
pnpm db:seed             # idempotent development data

# Infrastructure
pnpm infra:up / infra:down / infra:logs
pnpm infra:reset         # destroys all volumes and starts clean

# Quality
pnpm verify              # format check, lint, typecheck, unit tests
pnpm typecheck           # tsc -b across the whole graph
pnpm lint                # ESLint, type-aware
pnpm test                # unit tests (no infrastructure needed)
pnpm test:integration    # needs infra:up + db:migrate
pnpm test:e2e            # needs infra + `pnpm dev` running

# Production build
pnpm build               # compiles every package, app and the frontend
pnpm --filter @rook/desktop tauri:build   # packaged desktop binary

# Self-hosted server (Docker, behind a Cloudflare tunnel)
pnpm server:init         # write .env.server with generated secrets
pnpm server:up           # build and start the whole backend
pnpm server:ps           # status of every container
pnpm server:logs         # follow all logs
pnpm server:down         # stop, keeping all data
pnpm server:verify       # publish the proxy locally and smoke-test the stack
```

---

## Testing

Three suites, separated by what they need:

| Suite                   | Needs                    | Covers                                                                              |
| ----------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `pnpm test`             | nothing                  | Domain logic, validation, auth primitives, image processing, the message store      |
| `pnpm test:integration` | infra + migrations       | Real SQL: idempotency, cursor pagination, the outbox transaction, presigned uploads |
| `pnpm test:e2e`         | infra + running services | The whole flow over HTTP and WebSocket, as a black box                              |

Unit tests run with no infrastructure on purpose: a fresh clone with no Docker
still gets a meaningful signal. The integration suite fails with setup
instructions rather than a connection error if the infrastructure is missing.

---

## Repository layout

```text
rook/
├── apps/
│   ├── api/             HTTP API (Fastify)
│   ├── realtime/        WebSocket gateway + outbox relay
│   └── desktop/         Tauri 2 + React 19 client
├── packages/
│   ├── contracts/       Shared Zod schemas: HTTP, events, transport envelope
│   ├── database/        Schema, migrations, repositories, partition routing
│   ├── auth/            Argon2, session tokens, capability resolution
│   ├── messaging/       Chat domain logic (messages, channels, communities, media)
│   ├── media/           Object storage port, content detection, Sharp processing
│   ├── queue/           Job contracts over BullMQ
│   ├── config/          Validated environment configuration
│   ├── observability/   Logging, metrics, health, graceful shutdown
│   └── ui/              Design tokens and frontend primitives
├── services/
│   └── media-worker/    Asynchronous image processing
├── infrastructure/docker/   Container configuration
├── tests/               Integration and e2e suites
└── docs/                Architecture, scaling, limitations, decision records
```

Migrations live in `packages/database/migrations` rather than under
`infrastructure/`, so a query and the index it depends on change in one
reviewable commit.

---

## Documentation

| Document                                     | What it covers                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [docs/self-hosting.md](docs/self-hosting.md) | Running the backend on a home server behind a Cloudflare tunnel, and distributing the client                      |
| [docs/architecture.md](docs/architecture.md) | How the pieces fit, and the reasoning behind each boundary                                                        |
| [docs/scaling.md](docs/scaling.md)           | The staged path from one instance to many, and the sharding strategy -- including what is only an interface today |
| [docs/limitations.md](docs/limitations.md)   | Everything not implemented, and known rough edges                                                                 |
| [docs/operations.md](docs/operations.md)     | Health checks, metrics, deployment order, what to watch                                                           |
| [docs/adr/](docs/adr/)                       | Decision records for the choices that are hard to reverse                                                         |
| [.env.example](.env.example)                 | Every environment variable, with its purpose                                                                      |
| [.env.server.example](.env.server.example)   | The same, for a self-hosted deployment                                                                            |

---

## Security posture

The measures actually implemented here, so they can be reviewed rather than
assumed:

- **Passwords** are Argon2id with configurable cost; hashes are upgraded in
  place on login when the cost is raised.
- **Sessions** are opaque random tokens, stored only as
  `SHA-256(pepper || token)`, and revocable server-side immediately.
- **Login** returns one error for an unknown account and a wrong password, and
  performs a dummy verification when no account matches so the two take the
  same time.
- **Authorisation** is resolved server-side on every request through a single
  capability module; a non-member gets "not found" rather than "forbidden", so
  endpoints cannot be used to enumerate what exists.
- **All SQL** is parameterised through one tagged-template builder; `raw()` is
  the only escape hatch and is used solely for keywords from closed sets.
- **Uploads** never pass through the API. File type is determined from magic
  bytes, never the client's claim; images are re-encoded to strip metadata, with
  pixel and dimension limits enforced from the header before decoding.
- **Rate limits** are Redis-backed, so they hold across API instances.
- **The Tauri shell** grants the frontend only a scoped key-value store and
  "open a URL". No filesystem, shell, process or HTTP-client access --
  see [capabilities](apps/desktop/src-tauri/capabilities/README.md).

`docs/limitations.md` is equally explicit about what is _not_ hardened.

---

## Licence

MIT.
