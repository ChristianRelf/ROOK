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
- Channel categories: create, rename, delete (its channels survive as
  uncategorised), and bulk reorder
- Mentions: `@username` and `@everyone`, resolved server-side at write time,
  re-resolved on edit, and cleared on delete
- Unread and mention counts, derived from a stored read position with a bounded
  query cost, including per-channel muting and per-community rollups
- Member list pagination, cursor-based, with a stable total count
- Role management: promote and demote between `member` and `admin`, and remove
  a member, with the ranking rules enforced (no admin can act on a peer, on the
  owner, or on themselves)
- Invite links: expiring, use-limited, revocable, with a preview a non-member
  can read and a redemption that cannot be raced past its use limit
- The audit log: every administrative mutation written in the same transaction
  as the change, cursor-paginated and filterable, readable only by admins
- Idempotent sends: a retried request resolves to one message and one event
- Reconnection with gap recovery over HTTP, with no duplicated messages
- The full media pipeline: presigned upload, content verification, background
  processing, thumbnail generation, and delivery through expiring URLs
- Rejection paths: disguised file types, corrupt images, oversized uploads
- Authorisation isolation: non-members cannot read, post, subscribe or probe

Test counts: 165 unit, 37 integration, 13 end-to-end.

The administration, mention and unread surfaces were additionally exercised
against a running API with four accounts at different roles -- 99 assertions
covering every endpoint above, each authorisation boundary, and the ordering
and pagination guarantees. That pass found and fixed three real defects, all
noted in the git history: a channel row left committed after the request that
created it reported failure, an invite you had already used reporting itself as
exhausted instead of taking you to the community, and a gateway refusing to
subscribe to a channel created during the connection.

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
| Desktop or push notifications            | Mentions are resolved, counted and badged in the sidebar, but nothing raises an OS notification or a sound. The data to drive one is all there.          |
| Mention autocomplete                     | `@` does not open a member picker in the composer. A mention has to be typed in full, and a typo silently notifies nobody.                               |
| File types other than images             | The pipeline is image-only by design. Other types need their own validation and processing.                                                              |
| Message pinning, forwarding, drafts sync | —                                                                                                                                                        |

### Administration and moderation

| Not built                             | Note                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ban list                              | A removed member can rejoin with any valid code or invite. Kicking is implemented; banning needs its own table and a check on the join paths.                                                                            |
| Ownership transfer                    | `owner` is deliberately absent from the assignable role set, so a community's owner cannot be changed. Folding it into the role dropdown is how an admin gives a community away by misclicking; it needs its own flow.   |
| Server-side mute or timeout           | Muting is per-viewer and local to notifications. There is no way to stop someone posting.                                                                                                                                |
| Audit log retention                   | Entries are kept for ever and only removed when the community is. There is no pruning job; the outbox has one and this should follow the same pattern.                                                                   |
| Community deletion and renaming       | The capabilities are defined and `community.updated` is in the audit action enum; no endpoint implements either.                                                                                                         |
| Per-category permissions              | Categories are structure only. Deliberate: per-category overrides are the single biggest source of "why can't I see this channel" confusion, and adding them later is additive.                                          |
| Account deletion                      | Deliberately absent. `messages.author_id` is `ON DELETE RESTRICT`, so a user with messages cannot be deleted. Doing it properly needs an anonymisation strategy, which is a product decision as much as a technical one. |
| Email verification and password reset | No email is sent anywhere. There is no SMTP integration, so a forgotten password is unrecoverable. **This is the most significant gap for any real deployment.**                                                         |
| Two-factor authentication             | —                                                                                                                                                                                                                        |

### Client

| Not built                 | Note                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drag-and-drop reordering  | The API accepts a whole-sidebar reorder in one request (`POST .../channels/reorder` and the category equivalent), and the repository applies it in one statement. Nothing in the UI calls them yet -- channels and categories append in creation order. |
| Invite deep links         | An invite renders as `rook://invite/<code>`, but the app does not register a protocol handler, so clicking one does nothing. Pasting the link into the join dialog works -- it reduces a pasted URL to its last path segment.                           |
| Light theme               | Tokens are structured for it (`:root` custom properties) but only dark values are defined.                                                                                                                                                              |
| Keyboard shortcuts        | Enter/Shift+Enter in the composer and Escape in dialogs and menus only. No channel switching, no quick switcher, and no "mark all read".                                                                                                                |
| Member search server-side | The member filter in community settings searches only the pages already loaded, and says so in the UI. The endpoint has no search parameter; adding one needs an index on `users.display_name`.                                                         |
| Offline queue             | Messages composed while offline are not queued for later. A send fails visibly with a retry button, and the retry is manual.                                                                                                                            |
| Window state persistence  | Size and position are not remembered.                                                                                                                                                                                                                   |
| Auto-update               | No updater configured.                                                                                                                                                                                                                                  |
| Accessibility audit       | Dialogs set `aria-modal` and move focus, controls are labelled, and focus styles are keyboard-only — but there has been no screen-reader pass and no focus-trap inside dialogs (focus can leave a dialog by tabbing).                                   |
| Animated image support    | An animated GIF is processed to a still thumbnail. Only the first frame is read, deliberately, to keep memory bounded.                                                                                                                                  |

---

## Known rough edges

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

### Join codes are low-entropy and permanent — use an invite instead

`quiet-harbour-7421` is two words from 24 and four digits — roughly 19 bits.
It is a convenience for sharing, not an access control. It does not expire,
cannot be rotated, and has no use limit. Do not treat a community as private
because its code is unpublished.

Invite links are the answer to all of that: 72 bits of entropy, optional
expiry, optional use limit, and revocable. The join code remains because it is
the one thing you can read aloud, and removing it would break every community
created before invites existed.

Both paths are deliberately distinguishable in the audit log -- a `member.joined`
entry records `via: "join_code"` or `via: "invite"` plus the invite's id -- so
"how did this person get in" is answerable after the fact.

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

### A removed member keeps their socket subscriptions until they reconnect

The gateway resolves which channels a user may subscribe to at `identify` and
caches the set, because it is consulted on every subscribe. It is re-resolved
on demand when a client asks for a channel the cached set does not contain --
which is what makes a channel created _during_ the connection subscribable --
but it is never _narrowed_ while the socket is open.

So if a member is removed from a community mid-session, their existing socket
keeps receiving messages for channels it had already subscribed to, until it
drops. HTTP requests are authorised per request and are unaffected, so they
cannot read history, post, or load anything new; the leak is limited to live
messages in channels they were already watching.

This became reachable with the member-removal endpoint. Fixing it properly
means the gateway reacting to `member.removed` by dropping that user's
subscriptions, which the event already carries enough information to do -- the
envelope is community-scoped and names the user. It is a small change and the
right next one to make on this path.

### Unread counts are capped, and the cap is visible

A channel's unread count stops at 99 and renders as "99+", because the query
that derives it stops counting at 100 rows. That is what keeps a channel with
40,000 unread messages as cheap to summarise as one with four. Mentions are
counted under the same cap, which is far above any realistic number but is
still a cap.

The counts are derived on read from a stored read position rather than
maintained as a counter, so they cannot drift out of step with the messages
they describe -- but it does mean the summary is a query per request rather
than a lookup. It is one statement for every channel a user can see, and the
client holds it for 15 seconds.

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
2. **Narrow gateway subscriptions on `member.removed`** — small, and currently
   the only place where authorisation lags behind a change. See the rough edge
   above.
3. **UI verification** — a Playwright pass over the flows, which this release
   does not have. The administration surfaces added the most untested rendering.
4. **Desktop notifications** — mentions are already resolved, counted and
   badged; raising an OS notification is the missing half of the feature.
5. **Drag-and-drop sidebar reordering** — the API and the repository already
   do the whole operation in one request; only the UI is missing.
6. **Search** — `tsvector` and a GIN index on `messages.content`.
7. **Audit log pruning** — follow the outbox's bounded-delete pattern.
