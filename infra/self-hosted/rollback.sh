#!/usr/bin/env bash
# Roll the running service back to the previous standalone release.
#
#   ./infra/self-hosted/rollback.sh          # previous release
#   ./infra/self-hosted/rollback.sh <name>   # a specific release directory name
set -euo pipefail

DEPLOY_ROOT="${T3_DEPLOY_ROOT:-$HOME/.local/share/t3code}"
RELEASES_DIR="$DEPLOY_ROOT/releases"
CURRENT_LINK="$DEPLOY_ROOT/current"
SERVICE="${T3_SERVICE:-t3code}"
HEALTH_URL="${T3_HEALTH_URL:-http://127.0.0.1:3773/}"

current="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"

if [ $# -ge 1 ]; then
  target="$RELEASES_DIR/$1"
else
  # shellcheck disable=SC2012
  target="$(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | while read -r d; do
    d="${d%/}"
    [ "$(readlink -f "$d")" = "$current" ] || { echo "$d"; break; }
  done)"
fi

[ -n "${target:-}" ] && [ -d "$target" ] || {
  echo "no release to roll back to. Available:" >&2
  ls -1t "$RELEASES_DIR" 2>/dev/null >&2 || true
  exit 1
}

echo "==> Rolling back to $target"
cat "$target/RELEASE_INFO" 2>/dev/null || true

ln -sfn "$target" "$CURRENT_LINK.tmp"
mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"
systemctl --user restart "$SERVICE"

for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 3 "$HEALTH_URL"; then
    echo "==> Healthy on $target"
    exit 0
  fi
  sleep 2
done

echo "ERROR: still unhealthy after rollback — check 'journalctl --user -u $SERVICE -n 100'" >&2
exit 1
