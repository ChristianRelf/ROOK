# Production image for the Rook Node services.
#
# One Dockerfile for all three (api, realtime, media-worker): they share the
# whole dependency graph, so building them separately would mean installing and
# compiling the monorepo three times. The service is selected at runtime by
# `SERVICE`, which keeps the layer cache shared and the registry footprint
# roughly one image instead of three.
#
#   docker build -f infrastructure/docker/Dockerfile -t rook/services .
#
# Build from the repository root: the build context needs the whole workspace.

# ---------------------------------------------------------------------------
# Stage 1: dependencies
#
# Only the manifests are copied first, so this layer is reused on every build
# where no dependency changed -- which is most of them.
# ---------------------------------------------------------------------------
FROM node:24.15.0-alpine AS deps

# libc6-compat is needed by sharp's and argon2's prebuilt native binaries,
# which are built against glibc. Without it they fail to load at runtime with
# an opaque "cannot open shared object file".
RUN apk add --no-cache libc6-compat

RUN corepack enable pnpm

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./

COPY packages/auth/package.json           packages/auth/
COPY packages/config/package.json         packages/config/
COPY packages/contracts/package.json      packages/contracts/
COPY packages/database/package.json       packages/database/
COPY packages/media/package.json          packages/media/
COPY packages/messaging/package.json      packages/messaging/
COPY packages/observability/package.json  packages/observability/
COPY packages/queue/package.json          packages/queue/
COPY packages/ui/package.json             packages/ui/
COPY apps/api/package.json                apps/api/
COPY apps/realtime/package.json           apps/realtime/
COPY apps/desktop/package.json            apps/desktop/
COPY services/media-worker/package.json   services/media-worker/

# --frozen-lockfile so a drifted lockfile fails the build rather than silently
# resolving different versions than were tested.
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 2: build
#
# Compiles the whole project graph with one `tsc -b`.
# ---------------------------------------------------------------------------
FROM deps AS build

WORKDIR /app

COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/
COPY apps/realtime/ apps/realtime/
COPY services/media-worker/ services/media-worker/

# The desktop app is not built here: it is a client, shipped as a binary, and
# building it would pull Vite and Rust into a server image for nothing.
RUN pnpm exec tsc -b \
      packages/config \
      packages/observability \
      packages/contracts \
      packages/database \
      packages/auth \
      packages/queue \
      packages/media \
      packages/messaging \
      apps/api \
      apps/realtime \
      services/media-worker

# Drop dev dependencies now that compilation is done. This is where most of
# the image size saving comes from -- typescript, vitest and eslint are large.
RUN pnpm prune --prod

# ---------------------------------------------------------------------------
# Stage 3: runtime
# ---------------------------------------------------------------------------
FROM node:24.15.0-alpine AS runtime

RUN apk add --no-cache libc6-compat curl

# Runs as the image's existing unprivileged user rather than root. A container
# escape then lands on an account with no privileges.
ENV NODE_ENV=production

WORKDIR /app

# Only what is needed to run: built output, pruned dependencies, manifests
# (pnpm's symlinks in node_modules resolve through them) and the migration SQL.
COPY --from=build --chown=node:node /app/node_modules           ./node_modules
COPY --from=build --chown=node:node /app/package.json           ./
COPY --from=build --chown=node:node /app/pnpm-workspace.yaml    ./

COPY --from=build --chown=node:node /app/packages               ./packages
COPY --from=build --chown=node:node /app/apps/api               ./apps/api
COPY --from=build --chown=node:node /app/apps/realtime          ./apps/realtime
COPY --from=build --chown=node:node /app/services/media-worker  ./services/media-worker

# `SERVICE` selects which entry point runs. Defaults to the API so a bare
# `docker run` does something sensible.
ENV SERVICE=api

COPY --chmod=0755 infrastructure/docker/entrypoint.sh /usr/local/bin/rook-entrypoint

USER node

# Health is checked by Compose rather than here, so the probe can differ per
# service (the worker has no HTTP traffic, only a health port). Declared
# anyway so `docker run` on its own still reports status.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${HEALTH_PORT:-4000}/health/live" || exit 1

ENTRYPOINT ["/usr/local/bin/rook-entrypoint"]
