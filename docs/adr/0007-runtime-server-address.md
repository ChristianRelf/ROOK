# 0007 -- Server address resolved at runtime

**Status:** accepted
**Date:** 2026-10-27

## Context

Vite inlines `import.meta.env` at build time, so a server URL compiled into
the bundle can only be changed by rebuilding and redistributing the binary.

For a self-hosted application that is the wrong trade. A home server's address
changes, a tunnel hostname changes, someone testing on a LAN needs a different
address than someone connecting over the internet -- and the binary is
unsigned, so redistributing it means asking people to click through a
SmartScreen warning again.

## Decision

The compiled-in URLs are **defaults only**. The sign-in screen exposes a
server field; whatever the user sets is persisted via the platform store and
used from then on.

The realtime URL is **derived** from the server URL rather than asked for
separately: same origin, `ws`/`wss` to match the scheme, with the path `/ws`.

## Why

**One field, not two.** Asking for an API URL and a WebSocket URL doubles the
chance of a mismatch, and the two are the same origin in any deployment that
puts a reverse proxy in front -- which is what Caddy does here, routing `/ws`
to the gateway.

**A bare hostname is accepted.** `rook.example.com` becomes
`https://rook.example.com`, because that is what people type when reading an
address aloud. Anything that is not http(s) is refused, so a typo cannot
produce a URL the client tries to open.

**It is loaded before anything else.** The API client reads the address per
request rather than capturing it, and `App.tsx` applies the persisted value
before restoring the session -- otherwise a stored token would be sent to
whatever the compiled-in default happened to be.

## Consequences

- The build defaults keep `VITE_API_URL` and `VITE_REALTIME_URL` independent,
  so local development can still run the gateway on a separate port with no
  proxy. Only a user-entered address is derived as same-origin.
- A deployment that does **not** put the gateway on `/ws` of the API's origin
  cannot be reached by a user-entered address. That is a deliberate
  constraint: it keeps the field to one input, and the reverse proxy that makes
  it true is part of the documented deployment.
- The field is hidden behind a "Change server" link unless the address is
  already non-default or a connection has just failed, so infrastructure
  configuration does not sit above the password box.
- Settings shows the connected server read-only, since changing it mid-session
  would invalidate the current token.

## Alternatives considered

- **Hardcode one address** -- simpler, and what the first build did. Rejected
  once the deployment target was a tunnel hostname: any change to it would
  mean rebuilding and redistributing an unsigned binary to every user.
- **A separate first-run setup screen** -- more ceremony for a field most users
  never touch, since the default is correct for the intended deployment.
- **Service discovery (DNS SRV, a well-known endpoint)** -- real solutions at
  larger scale, and far more machinery than two people on a home server need.
