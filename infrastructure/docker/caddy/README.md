# Caddy

Internal HTTP router. Cloudflare terminates TLS; cloudflared forwards plain
HTTP here, so Caddy issues no certificates (`auto_https off`).

It exists for one reason: **the Cloudflare tunnel needs only one ingress rule
per hostname**, pointing at `http://caddy:80`. Routing then lives in the
`Caddyfile`, in version control, rather than in dashboard configuration that
nobody can review.

| Request                | Goes to                             |
| ---------------------- | ----------------------------------- |
| `/ws*`                 | `realtime:4001` (WebSocket upgrade) |
| `/health*`, `/metrics` | Refused with 404                    |
| everything else        | `api:4000`                          |

Health and metrics are blocked deliberately. They are unauthenticated and leak
request volumes and error rates, so they must not be reachable from the
internet. Scrape them on the internal Docker network instead.

Object storage is **not** routed through this hostname. Presigned URLs are
signed over the exact host and path the client requests, so a path prefix would
break the signature. It gets its own hostname -- see
[docs/self-hosting.md](../../../docs/self-hosting.md).
