#!/usr/bin/env bash
# One-time setup: point the systemd unit at the standalone release symlink
# instead of at the repo checkout.
#
#   ./infra/self-hosted/install-service.sh
#
# Idempotent — safe to re-run after changing the port, base dir, or node binary.
set -euo pipefail

DEPLOY_ROOT="${T3_DEPLOY_ROOT:-$HOME/.local/share/t3code}"
CURRENT_LINK="$DEPLOY_ROOT/current"
SERVICE="${T3_SERVICE:-t3code}"
UNIT_PATH="$HOME/.config/systemd/user/$SERVICE.service"

# Serve args — match what the unit ran before.
HOST="${T3_HOST:-127.0.0.1}"
PORT="${T3_PORT:-3773}"
BASE_DIR="${T3_BASE_DIR:-$HOME/.t3}"
PROJECT_DIR="${T3_PROJECT_DIR:-$HOME/code}"

# Pin node deliberately. Don't inherit ~/.vite-plus/js_runtime/node/<ver> — vite-plus
# garbage-collects old runtimes there, which would break ExecStart on a vp upgrade.
default_node="$HOME/.nvm/versions/node/v24.15.0/bin/node"
[ -x "$default_node" ] || default_node="$(command -v node || true)"
NODE_BIN="${T3_NODE_BIN:-$default_node}"
[ -x "$NODE_BIN" ] || { echo "no usable node binary (set T3_NODE_BIN)" >&2; exit 1; }

# Preserve the PATH the service already had: the server spawns agent CLIs, git and
# node as child processes, and they must stay findable.
existing_path="$(systemctl --user show "$SERVICE" -p Environment --value 2>/dev/null |
  tr ' ' '\n' | sed -n 's/^PATH=//p' | head -1)"
SERVICE_PATH="${T3_SERVICE_PATH:-${existing_path:-$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin}}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

mkdir -p "$DEPLOY_ROOT/releases" "$(dirname "$UNIT_PATH")"

if [ -f "$UNIT_PATH" ]; then
  backup="$UNIT_PATH.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$UNIT_PATH" "$backup"
  say "Backed up existing unit to $backup"
fi

say "Writing $UNIT_PATH"
cat > "$UNIT_PATH" <<EOF
[Unit]
Description=T3 Code server (self-hosted, standalone release)
After=network-online.target

[Service]
Type=simple
Environment=HOME=$HOME
Environment=PATH=$SERVICE_PATH
WorkingDirectory=$HOME
ExecStart=$NODE_BIN $CURRENT_LINK/dist/bin.mjs serve --host $HOST --port $PORT --base-dir $BASE_DIR $PROJECT_DIR
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
say "Unit installed. It will not start until a release exists:"
echo "    ./infra/self-hosted/release.sh"
echo
echo "Node binary pinned to: $NODE_BIN"
echo "Service PATH:          $SERVICE_PATH"
echo "Releases live in:      $DEPLOY_ROOT/releases"
