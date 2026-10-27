#!/usr/bin/env bash
#
# One-command setup for the Rook backend on a fresh Linux server.
#
#   curl -fsSL https://raw.githubusercontent.com/ChristianRelf/ROOK/main/scripts/bootstrap-server.sh | bash
#
# or, from a checkout:
#
#   ./scripts/bootstrap-server.sh
#
# Clones or updates the repository, writes `.env.server` with generated
# secrets if it does not exist, builds the images and starts the stack.
#
# Safe to re-run: it updates an existing checkout rather than replacing it,
# and never regenerates secrets over an existing `.env.server` -- doing so
# would orphan the volumes initialised with the old ones.
#
# Node is not required on the server. The one script that needs it runs in the
# same container image the services are built from.
set -euo pipefail

REPO_URL="${ROOK_REPO_URL:-https://github.com/ChristianRelf/ROOK.git}"
TARGET="${ROOK_DIR:-$HOME/rook}"
NODE_IMAGE="node:24.15.0-alpine"
HOSTNAME_ARG="${ROOK_HOSTNAME:-rook.relf.cc}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok() { printf '\033[32mok\033[0m    %s\n' "$1"; }
info() { printf '\033[2m      %s\033[0m\n' "$1"; }
die() {
  printf '\033[31merror\033[0m %s\n' "$1" >&2
  exit 1
}

# --- Prerequisites ---------------------------------------------------------
#
# Checked up front, together, so a missing one is reported before anything is
# written rather than halfway through.

bold 'Checking prerequisites'

command -v git >/dev/null 2>&1 || die 'git is not installed. apt install git'
ok 'git'

command -v docker >/dev/null 2>&1 || die 'docker is not installed. See https://docs.docker.com/engine/install/'
ok "docker ($(docker --version | cut -d' ' -f3 | tr -d ,))"

docker compose version >/dev/null 2>&1 ||
  die 'the docker compose plugin is missing. apt install docker-compose-plugin'
ok "docker compose ($(docker compose version --short))"

# Running the whole stack through sudo is avoidable and worth avoiding: the
# compose file needs no root, and the volumes end up owned correctly.
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon as $(id -un).

  Either add yourself to the docker group and log back in:
    sudo usermod -aG docker $(id -un) && newgrp docker

  or re-run this script with sudo."
ok 'docker daemon reachable'

# --- Checkout --------------------------------------------------------------

bold ''
bold 'Fetching the repository'

if [ -d "$TARGET/.git" ]; then
  git -C "$TARGET" remote set-url origin "$REPO_URL"
  git -C "$TARGET" fetch --quiet origin
  # Only fast-forward. A local commit on the server is a surprise worth
  # stopping for rather than overwriting.
  if ! git -C "$TARGET" merge --ff-only --quiet origin/main 2>/dev/null; then
    die "$TARGET has local commits or changes that would be overwritten.
  Resolve them there, then re-run."
  fi
  ok "updated $TARGET"
elif [ -e "$TARGET" ]; then
  die "$TARGET exists but is not a git checkout. Move it aside or set ROOK_DIR."
else
  git clone --quiet "$REPO_URL" "$TARGET"
  ok "cloned into $TARGET"
fi

cd "$TARGET"

# --- Configuration ---------------------------------------------------------

bold ''
bold 'Configuration'

if [ -f .env.server ]; then
  ok '.env.server already exists, keeping it'
  info 'secrets are never regenerated: the volumes were initialised with them'
else
  # `docker run` rather than a node dependency on the host. --user keeps the
  # written file owned by the invoking user instead of root.
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$PWD:/work" -w /work \
    "$NODE_IMAGE" node scripts/init-server-env.mjs --hostname="$HOSTNAME_ARG"
  chmod 600 .env.server
fi

token="$(grep '^CLOUDFLARE_TUNNEL_TOKEN=' .env.server | cut -d= -f2-)"
if [ -z "$token" ] || [ "$token" = 'PASTE_YOUR_TUNNEL_TOKEN_HERE' ] || [ "$token" = 'CHANGE_ME' ]; then
  bold ''
  printf '\033[33mstop\033[0m  CLOUDFLARE_TUNNEL_TOKEN is not set in %s/.env.server\n' "$TARGET"
  cat <<'MSG'

      Everything else is ready. The token is the one value that cannot be
      generated, and without it the tunnel cannot connect -- so the stack
      would start but stay unreachable.

      Get it from the Cloudflare dashboard:
        Zero Trust -> Networks -> Tunnels -> your tunnel -> Install a
        connector. Copy the long string after `--token`.

      Then set it and start the stack:
MSG
  printf '        cd %s
' "$TARGET"
  cat <<'MSG'
        nano .env.server
        docker compose -f docker-compose.server.yml --env-file .env.server up -d --build

      Also add two public hostnames to the tunnel, both first-level
      subdomains of your zone:
        rook         HTTP  caddy:80
        rook-files   HTTP  storage:8333

      Full walkthrough: docs/self-hosting.md
MSG
  exit 2
fi
ok 'tunnel token is set'

# --- Start -----------------------------------------------------------------

bold ''
bold 'Building and starting (first build takes a few minutes)'

docker compose -f docker-compose.server.yml --env-file .env.server up -d --build

bold ''
bold 'Status'
docker compose -f docker-compose.server.yml --env-file .env.server ps -a

cat <<MSG

$(bold 'Done.')

      Expect: healthy for postgres, redis, storage, api, realtime and
      media-worker; Exited (0) for migrate and storage-init; Up for caddy
      and cloudflared.

      Confirm the tunnel registered:
        docker compose -f docker-compose.server.yml --env-file .env.server \
          logs cloudflared | grep -i registered

      Then, from anywhere:
        curl https://$HOSTNAME_ARG/

      Day-to-day commands are in docs/self-hosting.md.
MSG
