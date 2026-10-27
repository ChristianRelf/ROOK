#!/bin/sh
# Selects which Rook service this container runs.
#
# One image serves all three because they share the entire dependency graph;
# `SERVICE` picks the entry point. An unknown value fails loudly rather than
# starting the wrong thing.
#
# `exec` matters: it replaces this shell with Node, so Node becomes PID 1 and
# receives SIGTERM directly. Without it the signal would stop at the shell and
# the container would be killed after the stop timeout instead of draining
# through the graceful shutdown handlers.
set -eu

case "${SERVICE:-api}" in
  api)
    exec node /app/apps/api/dist/index.js
    ;;
  realtime)
    exec node /app/apps/realtime/dist/index.js
    ;;
  media-worker)
    exec node /app/services/media-worker/dist/index.js
    ;;
  *)
    echo "Unknown SERVICE '${SERVICE:-}'. Expected: api, realtime or media-worker." >&2
    exit 64
    ;;
esac
