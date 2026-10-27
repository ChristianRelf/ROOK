# 0004 -- Bearer tokens over cookies

**Status:** accepted
**Date:** 2026-10-27

## Context

Rook's first client is a Tauri desktop application. Its webview runs on a
`tauri://` (or `http://tauri.localhost`) origin and talks to an API on a
different origin entirely.

Cookies in that arrangement are awkward: they need `SameSite=None; Secure`,
which means TLS even in development, plus exact-origin CORS with
`credentials: true`, and the webview's cookie jar behaves differently across
the three platform webviews. Each of those is somewhere to go subtly wrong in a
way that works on one machine and not another.

## Decision

Sessions are **opaque bearer tokens**, returned in the response body and sent
in an `Authorization: Bearer` header. They are rows in PostgreSQL, stored only
as `SHA-256(pepper || token)`.

## Why

**Revocation works.** A session is a row, so marking it revoked takes effect on
the next request. A signed token (JWT) cannot be revoked before it expires
without a denylist -- which is a database read per request, exactly what the
JWT was meant to avoid.

**It suits the client.** A desktop app stores a token deliberately, somewhere
it chooses. There is no implicit ambient credential to reason about, and the
same token authenticates the HTTP API and the WebSocket handshake with no
second mechanism.

**The storage design limits the damage of a database leak.** Only the hash is
stored, peppered with a secret held in the environment, so a dump alone yields
nothing usable. SHA-256 rather than Argon2 is deliberate: the input is 256 bits
of CSPRNG output, not a guessable password, so there is nothing for a slow hash
to defend against -- and a per-request Argon2 verification would add ~80 ms to
every authenticated call for no security gain.

## Consequences

**This is the real cost: no `HttpOnly`.** A cookie marked `HttpOnly` is
unreachable from JavaScript, so an XSS cannot read it. A bearer token the
client stores is reachable by any script that achieves execution there.

Mitigations in place:

- A restrictive CSP on the webview: no inline scripts, no `eval`, no plugins,
  no framing.
- The Tauri capability set grants no filesystem, shell, process or HTTP-client
  access, so an XSS cannot escalate beyond the webview.
- Message content is never rendered as HTML -- React escapes it, so there is no
  sanitiser to get wrong.
- Tokens live in the OS application-data directory via Tauri's store plugin
  rather than `localStorage`, so in the desktop build they are not reachable
  through web storage APIs at all.

**A web client would need to revisit this.** In a browser, `localStorage` is
the only fallback and the XSS exposure is real. The right answer there is a
`HttpOnly; Secure; SameSite=Lax` cookie, keeping the token path for native
clients. The session layer already supports both: `parseBearerToken` is the
only place the header is read.

**No automatic refresh.** Sessions are long-lived (30 days by default) and
revocable, rather than short-lived with a refresh token. Refresh-token rotation
exists to limit the damage of a leaked access token, which matters when the
token cannot be revoked. Since these can be, the extra machinery buys little.

## Alternatives considered

- **JWT with short expiry plus refresh tokens** -- the refresh token is itself
  a long-lived credential needing a database row, so it lands back here with
  more moving parts.
- **Cookies with a shared origin behind a reverse proxy** -- viable, and the
  right answer for a web client. Rejected for the desktop-first case because it
  requires TLS and a proxy in development for no benefit.
