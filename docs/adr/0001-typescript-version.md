# 0001 -- TypeScript 6, not 7

**Status:** accepted
**Date:** 2026-10-27

## Context

TypeScript 7.0.2 was the `latest` tag on npm when this project started -- the
native (Go) port of the compiler, offering substantially faster builds.

Installing it produced unmet peer dependency warnings across the entire
typescript-eslint toolchain:

```text
typescript-eslint 8.72.1
  unmet peer typescript@">=4.8.4 <6.1.0": found 7.0.2
```

typescript-eslint 8.72.1 was itself the newest release; there was no 9.x. So no
version of the lint toolchain supported TypeScript 7.

## Decision

Pin TypeScript **6.0.3**, the newest release inside typescript-eslint's
supported range.

## Why

The deciding factor is what the lint toolchain provides. Type-aware linting
catches a specific and valuable class of bug in this codebase:

- `no-floating-promises` -- in a service full of pools, sockets and queues, an
  unawaited promise is a silent failure. This rule fired repeatedly during
  development and caught real mistakes.
- `no-misused-promises` -- an async function passed where a sync callback is
  expected, so its rejection is lost.
- `require-await` and the `no-unsafe-*` family -- keeps `any` from spreading
  out of a loosely typed dependency, which it did twice here (the AWS SDK's
  stream types, and `ws`'s `RawData`).

Without a supported typescript-eslint, none of that is available. Trading it
for faster compilation is a bad exchange: build time is an inconvenience, while
a swallowed rejection in the outbox relay is lost messages.

TypeScript 6.0.3 is a stable release, not a fallback to something old.

## Consequences

- Slower builds than TypeScript 7 would give. Not currently a bottleneck:
  `tsc -b` over the whole graph takes a few seconds.
- The upgrade is a one-line change in the root `package.json` once
  typescript-eslint supports 7. Nothing in the codebase relies on
  6-specific behaviour.
- `composite: true` requires declaration emit, so projects that produce no
  shipped JavaScript (`@rook/ui`, `apps/desktop`) emit declarations into a
  cache directory instead. Recorded because it looks odd without the reason.

## Revisit when

typescript-eslint publishes a release declaring support for TypeScript 7. At
that point, upgrade both together.
