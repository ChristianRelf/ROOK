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

typescript-eslint 8.72.1 was itself the newest release; there was no 9.x. So
there was no version of the lint toolchain that supported TypeScript 7.

## Decision

Pin TypeScript **6.0.3**, the newest release inside typescript-eslint's
supported range.

## Why

The deciding factor is what the lint toolchain provides. Type-aware linting
catches a specific and valuable class of bug in this codebase:

- `no-floating-promises` -- in a service full of pools, sockets and queues, an
  unawaited promise is a silent failure. This rule fires constantly during
  development and has caught real mistakes here.
- `no-misused-promises` -- an async function passed where a sync callback is
  expected, so its rejection is lost.
- `require-await`, `no-unsafe-*` -- keeps `any` from spreading from a loosely
  typed dependency.

Without a supported typescript-eslint, all of that is unavailable. Trading it
for faster compilation is a bad exchange: build time is an inconvenience,
a swallowed rejection in the outbox relay is lost messages.

TypeScript 6.0.3 is a stable release, not a fallback to something old.

## Consequences

- Slower builds than TypeScript 7 would give. Not currently a bottleneck:
  `tsc -b` over the whole graph is a few seconds.
- The upgrade is a one-line change in the root `package.json` once
  typescript-eslint supports 7. Nothing in the codebase depends on 6-specific
  behaviour.
- `composite: true` requires declaration emit, so projects that produce no
  shipped output (`@rook/ui`, `apps/desktop`) emit declarations to a cache
  directory instead. Noted because it looks odd without the reason.

## Revisit when

typescript-eslint publishes a release declaring support for TypeScript 7. At
that point, upgrade both together.
