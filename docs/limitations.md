# Limitations

What this release does not do, and where it is rough. Written plainly so nobody
has to discover these by reading source or, worse, in production.

---

## Verified as working

So the gaps below are read against an accurate baseline. All of the following
was exercised against real PostgreSQL, Redis and object storage:

- Registration, login, logout, session revocation, profile updates
- Creating and joining communities; creating and listing channels
- Sending, editing and deleting messages, with cursor pagination over history
- Realtime delivery between two clients, including edits, deletions, typing
  indicators and channel creation
- Idempotent sends: a retried request resolves to one message and one event
- Reconnection with gap recovery over HTTP, with no duplicated messages
- The full media pipeline: presigned upload, content verification, background
  processing, thumbnail generation, and delivery through expiring URLs
- Rejection paths: disguised file types, corrupt images, oversized uploads
- Authorisation isolation: non-members cannot read, post, subscribe or probe

Test counts: 145 unit, 37 integration, 13 end-to-end.

Additionally verified in the containerised deployment: the production Docker
image builds, migrations apply inside it, all three services report healthy,
and the full flow (register, community, channel, persisted message, live
WebSocket delivery, upload authorisation) works through the Caddy edge proxy
exactly as the Cloudflare tunnel reaches it -- 15 checks via
`pnpm server:verify`.

**Not verified:** the user interface has not been tested by driving a real
browser or the packaged desktop window — no browser automation was available in
the environment where this was built. The frontend compiles, type-checks
against the shared contracts, builds, and its message-store logic is unit
tested, but _rendering_ is unverified. Treat the UI as needing a manual pass.

---

## Not implemented

### Communication features

| Not built                                | Note                                                                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice and video                          | Explicitly out of scope. Would need WebRTC signalling and TURN.                                                                                          |
| Direct messages                          | Only community channels exist. A DM is a channel with a different membership model; the schema would need a nullable `community_id` or a separate table. |
| Threads and replies                      | No `parent_message_id`.                                                                                                                                  |
| Reactions                                | No table.                                                                                                                                                |
| Message search                           | No full-text index. `tsvector` on `messages.content` plus a GIN index is the obvious first step.                                                         |
| Mentions and notifications               | Usernames are stable and mention-ready, but nothing parses or notifies.                                                                                  |
| Read state / unread badges               | Nothing tracks what a user has seen. Needs a `channel_read_state` table keyed by (user, channel) holding the last-read message id.                       |
| File types other than images             | The pipeline is image-only by design. Other types need their own validation and processing.                                                              |
| Message pinning, forwarding, drafts sync | —                                                                                                                                                        |

### Administration and moderation

| Not built                             | Note                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invite links                          | Joining is by a community-wide code with no expiry, no use limit, and no revocation. Anyone with the code can join.                                                                                                      |
| Role management UI                    | Roles exist in the schema and are enforced, but nothing can change a member's role after they join.                                                                                                                      |
| Kick, ban, mute                       | No endpoints.                                                                                                                                                                                                            |
| Audit log                             | Session rows are retained, but no administrative action log.                                                                                                                                                             |
| Community deletion                    | The capability is defined; no endpoint implements it.                                                                                                                                                                    |
| Account deletion                      | Deliberately absent. `messages.author_id` is `ON DELETE RESTRICT`, so a user with messages cannot be deleted. Doing it properly needs an anonymisation strategy, which is a product decision as much as a technical one. |
| Email verification and password reset | No email is sent anywhere. There is no SMTP integration, so a forgotten password is unrecoverable. **This is the most significant gap for any real deployment.**                                                         |
| Two-factor authentication             | —                                                                                                                                                                                                                        |

### Client

| Not built                | Note                                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Member list pagination   | The endpoint is cursor-paginated; the sidebar renders only the first page and never requests more. A community over ~50 members shows a truncated list.                                                               |
| Light theme              | Tokens are structured for it (`:root` custom properties) but only dark values are defined.                                                                                                                            |
| Keyboard shortcuts       | Enter/Shift+Enter in the composer and Escape in dialogs only. No channel switching, no quick switcher.                                                                                                                |
| Offline queue            | Messages composed while offline are not queued for later. A send fails visibly with a retry button, and the retry is manual.                                                                                          |
| Window state persistence | Size and position are not remembered.                                                                                                                                                                                 |
| Auto-update              | No updater configured.                                                                                                                                                                                                |
| Accessibility audit      | Dialogs set `aria-modal` and move focus, controls are labelled, and focus styles are keyboard-only — but there has been no screen-reader pass and no focus-trap inside dialogs (focus can leave a dialog by tabbing). |
| Animated image support   | An animated GIF is processed to a still thumbnail. Only the first frame is read, deliberately, to keep memory bounded.                                                                                                |

---

## Known rough edges

### The packaged Windows binary crashes on launch

`pnpm --filter @rook/desktop tauri:build` produces a working binary and
installers, but the **release** executable panics immediately on start
(exit `0xC0000409`). The frontend builds, type-checks and runs fine under the
Vite dev server, and `cargo check` passes, so this is specific to the packaged
release build. Under investigation; the development path
(`pnpm dev:desktop`, or `pnpm desktop:tauri`) is unaffected.

### The desktop session token is not encrypted at rest

It is stored via Tauri's store plugin in the OS application-data directory,
with that directory's filesystem permissions as the only protection. It is not
in the OS keychain and not encrypted. Another process running as the same user
can read it.

Using the platform keyring (`tauri-plugin-stronghold`, or Keychain/Credential
Manager directly) would be better. The current approach is still a clear
improvement on `localStorage`, which the browser fallback uses and which is
reachable from any script achieving XSS.

### No session cache: a database read per authenticated request

Every authenticated request resolves its token with a query. It is a single
indexed lookup joined to the user, so it is cheap, but it is not free.

Caching it in Redis with a short TTL would remove most of those reads, at the
cost of revocation taking up to the TTL to take effect. That was judged the
wrong trade for a first release: "log out everywhere" working immediately
matters more than saving one indexed lookup. If added, deleting the cache entry
on logout handles the common case and leaves only administrative revocation
lagging.

### Join codes are low-entropy and permanent

`quiet-harbour-7421` is two words from 24 and four digits — roughly 19 bits.
It is a convenience for sharing, not an access control, and it is documented as
such. It does not expire, cannot be rotated, and has no use limit. Do not treat
a community as private because its code is unpublished.

### Rate limits are per instance for the global limiter only in failure

Limits are Redis-backed and therefore shared. But `enableOfflineQueue: false`
means that if Redis is unavailable, `@fastify/rate-limit` fails open — requests
are allowed rather than rejected. That is the right default (a Redis outage
should not take down the API) but it means rate limiting is not a defence
during a Redis outage.

### The outbox relay adds latency

Delivery latency includes up to `OUTBOX_POLL_INTERVAL_MS` (250 ms by default)
of polling delay. Measured end-to-end delivery was around 150 ms. Lowering the
interval reduces latency and increases database round trips; `LISTEN/NOTIFY`
would remove the polling but does not survive a disconnect, so a restarting
gateway would miss the notification and the row would sit unpublished until
something else polled.

### Channel access is cached for a connection's lifetime

The gateway resolves which channels a user may subscribe to once, at
`identify`. If a user is removed from a community mid-session, their existing
socket keeps its subscriptions until they reconnect. HTTP requests are checked
per request and are unaffected.

A `member.removed` event invalidating the cached set would fix it. There is no
removal endpoint yet, so the situation cannot currently arise.

### Media assets are owner-scoped only

`GET /v1/media/:id` serves only the owner. Attachments reach other members
through the message that carries them (which is membership-checked), and that
response embeds the asset metadata — but a non-owner cannot fetch fresh
download URLs for an attachment directly. For the current UI, where
attachments render from the message payload, this works. A shared-asset
permission model is future work.

### Orphan cleanup is time-based, not reference-counted

Reservations never confirmed are swept an hour after creation. The sweeper does
check that an asset is unreferenced before deleting, but an upload interrupted
and legitimately resumed after an hour would find its reservation gone.

### No connection draining coordination between gateways

On redeploy a gateway closes its sockets with code 4000, and clients reconnect
with jittered backoff. With a rolling deploy this is fine. Restarting every
gateway simultaneously would produce a reconnect spike that the jitter spreads
but does not eliminate.

### `docker-compose` is for development only

Weak credentials, no TLS, no resource limits, no backups, and ports published
to localhost. It is not a production deployment and is not intended as one.

### Windows-specific setup friction

Two things bite on Windows and are documented in the README: Hyper-V reserves
port ranges (so a bind can fail with a permissions error rather than "in
use"), and PostgreSQL 18's image expects its volume at `/var/lib/postgresql`
rather than `/var/lib/postgresql/data`.

---

## Dependency choices forced by external changes

Three upstream changes shaped this build, all verified rather than assumed:

- **MinIO images now require registry authentication** on both Docker Hub and
  quay.io, so they cannot be a zero-friction local dependency.
- **LocalStack's current image requires a paid auth token** and exits
  immediately without one.
- **TypeScript 7 is not yet supported by typescript-eslint** (which declares
  `<6.1.0`), so adopting it would mean losing type-aware linting.

Hence SeaweedFS for object storage and TypeScript 6.0.3. See
[adr/0001-typescript-version.md](adr/0001-typescript-version.md) and
[adr/0002-object-storage-choice.md](adr/0002-object-storage-choice.md).

---

## If you take this further

The order that gets the most value for the least risk:

1. **Email** — verification and password reset. Everything else is cosmetic
   next to an unrecoverable password.
2. **Read state** — unread indicators are the first thing users miss.
3. **Invites** — replace the community-wide code with expiring, revocable,
   limited-use invites.
4. **Member list pagination** — small, and currently a visible truncation bug.
5. **Search** — `tsvector` and a GIN index on `messages.content`.
6. **UI verification** — a Playwright pass over the flows, which this release
   does not have.
