# Self-hosting Rook on a home server

Runs the whole backend in Docker behind a Cloudflare tunnel. No port
forwarding, no inbound firewall rules, and TLS handled at Cloudflare's edge.

Written for the deployment this was built against: a home server, a handful of
users, and `rook.relf.cc` as the hostname. Substitute your own.

---

## What you end up with

```text
   your mate's laptop                        your home server
┌──────────────────────┐              ┌──────────────────────────────────┐
│  Rook desktop app    │              │  docker compose                  │
│                      │              │                                  │
│  https://rook.relf.cc│──┐           │  ┌─────────┐   ┌──────────────┐ │
└──────────────────────┘  │           │  │  caddy  │──▶│ api     :4000│ │
                          │           │  │   :80   │   ├──────────────┤ │
                   ┌──────▼───────┐   │  │         │──▶│ realtime:4001│ │
                   │  Cloudflare  │   │  └────▲────┘   └──────────────┘ │
                   │     edge     │   │       │        ┌──────────────┐ │
                   │  (TLS here)  │   │       │        │ media-worker │ │
                   └──────┬───────┘   │  ┌────┴──────┐ └──────────────┘ │
                          │           │  │cloudflared│                  │
                          └───────────┼─▶│ (outbound)│  postgres        │
                             tunnel   │  └───────────┘  redis           │
                                      │                 storage         │
                                      └──────────────────────────────────┘
```

`cloudflared` makes an **outbound** connection to Cloudflare. Nothing listens
on a public port, and the compose stack publishes nothing to the host at all.

---

## Why two hostnames

| Hostname             | Serves                                           |
| -------------------- | ------------------------------------------------ |
| `rook.relf.cc`       | The API, and the WebSocket gateway on `/ws`      |
| `rook-files.relf.cc` | Object storage, for direct uploads and downloads |

Storage needs its own hostname rather than a path prefix. Presigned URLs are
signed over the exact host **and path** the client requests, so putting storage
at `rook.relf.cc/files/...` would invalidate every signature the moment a proxy
rewrote the path. Two hostnames avoids the problem entirely.

The API and the gateway do share one hostname, because Caddy routes `/ws` to
the gateway without rewriting anything.

### Why `rook-files` and not `files.rook`

Both hostnames are deliberately **first-level** subdomains of the zone --
siblings, not parent and child.

Cloudflare's free Universal SSL certificate covers the apex and `*.zone`: one
level of wildcard. `files.rook.relf.cc` is a second-level subdomain, so
`*.relf.cc` does not match it. DNS resolves, the tunnel routes, and then TLS
fails at the edge with `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` -- which reads like
a cipher negotiation problem and is actually a missing certificate.

Covering a deeper name needs
[Advanced Certificate Manager](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/),
a paid add-on. Keeping both names first-level costs nothing instead.

The usual workaround of setting the record to DNS-only does not apply here,
because tunnel hostnames have to be proxied.

So: `rook-files.relf.cc`, not `files.rook.relf.cc`. `pnpm server:init` derives
it this way, turning `<name>.<zone>` into `<name>-files.<zone>`.

---

## 1. Create the tunnel

In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels → Create a
tunnel**, choose **Cloudflared**, name it `rook`.

Copy the token from the install command it shows you — the long string after
`--token`. You do not need to run that command; the compose stack runs
`cloudflared` for you.

Then add two **public hostnames** to the tunnel:

| Subdomain    | Domain    | Type   | URL            |
| ------------ | --------- | ------ | -------------- |
| `rook`       | `relf.cc` | `HTTP` | `caddy:80`     |
| `rook-files` | `relf.cc` | `HTTP` | `storage:8333` |

`HTTP`, not HTTPS: Cloudflare terminates TLS at the edge and forwards plain
HTTP into the tunnel, so the services need no certificates.

The service values are Docker service names, which resolve because
`cloudflared` runs on the same Compose network.

DNS records are created for you.

### Settings worth changing

On the `rook-files` hostname, under **Additional application settings → HTTP
settings**, leave _Disable Chunked Encoding_ off. Uploads are a single PUT, so
chunking is not involved.

In the Cloudflare dashboard for the zone, consider:

- **Caching:** default is fine. Presigned URLs carry query strings, which
  Cloudflare does not cache by default — correct, since they expire.
- **Upload size:** Cloudflare's free plan caps request bodies at **100 MB**.
  Rook's own limit is 10 MB (`MEDIA_MAX_UPLOAD_BYTES`), so this never binds.
- **WebSockets:** enabled by default on all plans. Confirm under
  **Network → WebSockets** if a connection fails to upgrade.

---

## 2. Configure the server

```bash
git clone <repository-url> rook
cd rook

pnpm server:init --token=<the token from step 1>
```

`.env.server` is git-ignored, so a fresh clone never has one. `server:init`
writes it from `.env.server.example` with every secret generated:
`POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `SESSION_TOKEN_PEPPER`,
`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.

It refuses to overwrite an existing `.env.server`, because regenerating the
secrets would orphan the volumes that were initialised with the old ones.

For a hostname other than `rook.relf.cc`:

```bash
pnpm server:init --hostname=chat.example.com
```

That sets `PUBLIC_HOSTNAME`, `PUBLIC_FILES_HOSTNAME`, `API_PUBLIC_URL`,
`REALTIME_PUBLIC_URL` and `S3_PUBLIC_ENDPOINT` together. The files hostname
defaults to `files.<hostname>`; override it with `--files-hostname=`.

Omit `--token` and the file is written with a placeholder for you to fill in.
That is the only value the script cannot generate.

### Doing it by hand instead

```bash
cp .env.server.example .env.server
```

Then generate each secret rather than inventing one:

```bash
openssl rand -base64 32    # POSTGRES_PASSWORD
openssl rand -base64 32    # REDIS_PASSWORD
openssl rand -base64 48    # SESSION_TOKEN_PEPPER
openssl rand -hex 16       # S3_ACCESS_KEY_ID
openssl rand -hex 32       # S3_SECRET_ACCESS_KEY
```

Two things that catch people out, and the reason the script exists:

- **`DATABASE_URL` and `REDIS_URL` embed their passwords.** Update the URL as
  well as the `POSTGRES_PASSWORD` / `REDIS_PASSWORD` variable, or the services
  authenticate with a different value than the server was created with.
- **Avoid `: / @ ? #` in the Redis password.** It goes into a URL, and those
  characters change how it parses. (`server:init` uses base64url, which
  contains none of them.)

`.env.server` is git-ignored. Keep it that way.

---

## 3. Start it

```bash
docker compose -f docker-compose.server.yml --env-file .env.server up -d --build
```

The first build takes a few minutes. Start-up order is enforced by the compose
file: the data stores become healthy, then migrations run to completion, then
the three services start. None of them can come up against an out-of-date
schema.

Check it:

```bash
docker compose -f docker-compose.server.yml --env-file .env.server ps
```

You want `healthy` for postgres, redis, storage, api, realtime and
media-worker; `Exited (0)` for `migrate` and `storage-init`; and `Up` for
caddy and cloudflared.

```bash
# Follow the logs
docker compose -f docker-compose.server.yml --env-file .env.server logs -f api

# Confirm the tunnel connected
docker compose -f docker-compose.server.yml --env-file .env.server logs cloudflared | grep -i registered
```

From any machine:

```bash
curl https://rook.relf.cc/
# {"service":"rook-api","status":"ok"}
```

### Verifying without the tunnel

The stack publishes no ports, so there is nothing to curl locally. To exercise
it from the server itself, apply the override:

```bash
docker compose -f docker-compose.server.yml -f docker-compose.server.local.yml \
  --env-file .env.server up -d

curl http://127.0.0.1:8080/
```

That binds Caddy to loopback only. Remove the second `-f` and `up -d` again to
unpublish it.

---

## 4. Give your mate the app

The desktop binaries are in
`apps/desktop/src-tauri/target/release/bundle/` after
`pnpm --filter @rook/desktop tauri:build`:

| Platform | What to send                                |
| -------- | ------------------------------------------- |
| Windows  | `bundle/nsis/Rook_0.1.0_x64-setup.exe`      |
| macOS    | `bundle/dmg/Rook_0.1.0_aarch64.dmg`         |
| Linux    | `bundle/appimage/Rook_0.1.0_amd64.AppImage` |

**Builds are per platform.** A Windows machine produces Windows installers
only; your mate needs a build made on their own OS, or a CI runner for it.

The binary ships with `https://rook.relf.cc` as its default, so it connects
with no configuration. If that ever changes, the sign-in screen has a
**Change server** link — no new binary required.

Both of you then register in the app. The first person to create a community
owns it and can share its join code (the copy button in the channel sidebar
header).

### Unsigned binaries

Neither build is code-signed, so:

- **Windows** shows a SmartScreen warning. _More info → Run anyway_.
- **macOS** refuses to open it. Right-click → _Open_, or
  `xattr -d com.apple.quarantine /Applications/Rook.app`.

Signing needs a paid certificate from Microsoft or Apple. For two people
sharing a build directly, the warning is the cost of not having one.

---

## Day-to-day

```bash
C="docker compose -f docker-compose.server.yml --env-file .env.server"

$C ps                      # status
$C logs -f api             # follow a service
$C restart api             # restart one service
$C down                    # stop everything, keep all data
$C up -d --build           # update after pulling new code
```

`down` without `-v` keeps the volumes. **Never pass `-v`** unless you mean to
destroy the database, the uploads and the queue.

### Updating

```bash
git pull
docker compose -f docker-compose.server.yml --env-file .env.server up -d --build
```

Migrations run automatically as part of start-up, before the services start.

### Backups

PostgreSQL is the only thing that must be backed up — everything in Redis can
be rebuilt from it.

```bash
docker compose -f docker-compose.server.yml --env-file .env.server \
  exec -T postgres pg_dump --format=custom --no-owner -U rook rook \
  > rook-$(date +%F).dump
```

Uploaded files live in the `storage-data` volume. To include them:

```bash
docker run --rm -v rook-server_storage-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/rook-storage-$(date +%F).tar.gz -C /data .
```

### Restoring

```bash
$C down
docker volume rm rook-server_postgres-data
$C up -d postgres
# wait for healthy, then:
$C exec -T postgres pg_restore -U rook -d rook --clean --if-exists < rook-2026-10-27.dump
$C up -d
```

A caveat worth knowing: PostgreSQL and object storage are separate systems, so
restoring the database to an earlier point can leave media rows whose objects
are newer, and objects with no row. The orphan sweeper cleans up the latter;
the former shows as an image that fails to load.

---

## Security notes for this setup

What the tunnel gives you, and what it does not.

**Good:**

- No inbound ports, so nothing to port-forward and nothing exposed if a
  service misbehaves.
- TLS terminated at Cloudflare, with certificates managed for you.
- Your home IP is not published in DNS.
- Health and metrics endpoints are refused at the edge by Caddy — they are
  unauthenticated and would leak request volumes and error rates.

**Still your responsibility:**

- **Anyone who can reach `rook.relf.cc` can attempt to register.** There is no
  invite gate on registration. For two people, create both accounts and then
  consider putting Cloudflare Access in front of the hostname, or add a
  registration allow-list.
- **Join codes are low-entropy and permanent** (roughly 19 bits, no expiry, no
  revocation). They are a convenience for sharing, not an access control.
- **Rate limits are largely per-IP, and every request arrives from
  Cloudflare.** Per-user limits (messages, uploads) are unaffected, but the
  per-IP auth limit is effectively shared across everyone. Raise
  `RATE_LIMIT_AUTH_MAX` if legitimate sign-ins get throttled, and consider
  Cloudflare's own rate limiting, which does see real client IPs.
- **No password reset.** There is no email integration, so a forgotten password
  means recreating the account. This is the most significant gap for a real
  deployment — see [limitations.md](limitations.md).
- **Keep `.env.server` off any backup that leaves the house**, or the database
  dumps stop being useless to whoever finds them.

Consider **Cloudflare Access** (Zero Trust → Access → Applications) over the
hostname if you want authentication before Rook is even reachable. For two
people with Google or GitHub accounts it takes a few minutes and removes the
open-registration concern entirely.

---

## Troubleshooting

| Symptom                                                | Cause                                                                                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflared` restarting, exit 255                     | The tunnel token is wrong or still the placeholder. Check `logs cloudflared`.                                                                             |
| `curl https://rook.relf.cc/` returns a Cloudflare 502  | The tunnel is connected but the hostname points at the wrong service. It must be `caddy:80`, not `api:4000`.                                              |
| Sign-in works, messages never arrive live              | The WebSocket is not upgrading. Confirm **Network → WebSockets** is on for the zone, and that the client's server URL uses `https` (so it derives `wss`). |
| Uploads fail at the PUT step                           | `rook-files` hostname missing from the tunnel, or `S3_PUBLIC_ENDPOINT` not matching it.                                                                   |
| Uploads fail with `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` | No edge certificate for the storage hostname. It must be a first-level subdomain; free Universal SSL does not cover `files.rook.relf.cc`.                 |
| Uploads confirm but images never appear                | `media-worker` is not running, or failing. Check `logs media-worker`.                                                                                     |
| `migrate` exits 1 on first run                         | Usually `DATABASE_URL` disagreeing with `POSTGRES_PASSWORD`.                                                                                              |
| Services restart in a loop at start-up                 | Run `logs api`. Configuration errors are reported in full, naming each bad variable.                                                                      |
