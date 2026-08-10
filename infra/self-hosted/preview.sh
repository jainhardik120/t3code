#!/usr/bin/env bash
# Run the current build alongside production, on its own port and state dir, so
# a change can be looked at before it replaces the live server.
#
#   ./infra/self-hosted/preview.sh            # build, launch on :3774, print a pairing link
#   ./infra/self-hosted/preview.sh --no-build # reuse the newest packaged release
#   ./infra/self-hosted/preview.sh --pair     # print another pairing link
#   ./infra/self-hosted/preview.sh --stop     # tear the preview down
#
# Touches nothing production owns: its own systemd unit, its own port, and its
# own base dir, so its database, settings and pairings are all separate.
set -euo pipefail

# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

PREVIEW_UNIT="${T3_PREVIEW_UNIT:-t3code-preview}"
PREVIEW_PORT="${T3_PREVIEW_PORT:-3774}"
PREVIEW_BASE_DIR="${T3_PREVIEW_BASE_DIR:-$HOME/.t3-preview}"
PREVIEW_HOST="${T3_PREVIEW_HOST:-127.0.0.1}"
PROJECT_DIR="${T3_PROJECT_DIR:-$HOME/code}"
NODE_BIN="${T3_NODE_BIN:-$(command -v node)}"
BUILD=1
ACTION=start

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --stop) ACTION=stop ;;
    --pair) ACTION=pair ;;
    --port) PREVIEW_PORT="${2:?--port needs a value}"; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

preview_url="http://$PREVIEW_HOST:$PREVIEW_PORT"

# A preview that shares the live port or base dir is not a preview.
live_port="$(systemctl --user show "$SERVICE" -p ExecStart --value 2>/dev/null |
  grep -oE -- '--port [0-9]+' | awk '{print $2}' | head -1)"
[ "$PREVIEW_PORT" != "${live_port:-}" ] || die "port $PREVIEW_PORT is the live server's port"
[ "$PREVIEW_BASE_DIR" != "${T3_BASE_DIR:-$HOME/.t3}" ] || die "preview base dir must not be the live one"

mint_pairing() {
  local release="$1"
  say "Pairing link"
  "$NODE_BIN" "$release/dist/bin.mjs" auth pairing create \
    --base-dir "$PREVIEW_BASE_DIR" \
    --base-url "$preview_url" \
    --label "preview" 2>/dev/null || warn "could not mint a pairing link"
}

case "$ACTION" in
  stop)
    systemctl --user stop "$PREVIEW_UNIT" 2>/dev/null || true
    systemctl --user reset-failed "$PREVIEW_UNIT" 2>/dev/null || true
    say "Preview stopped"
    echo "Its state remains at $PREVIEW_BASE_DIR — delete it to start clean."
    exit 0
    ;;
  pair)
    target="$(readlink -f "$(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | head -1)")"
    [ -n "$target" ] || die "no packaged release to pair against"
    mint_pairing "$target"
    exit 0
    ;;
esac

cd "$REPO_ROOT"

if [ "$BUILD" -eq 1 ]; then
  say "Building and packaging (production is not touched)"
  "$SCRIPT_DIR/release.sh" --foreground --no-restart
fi

# shellcheck disable=SC2012
release="$(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | head -1)"
release="$(readlink -f "${release%/}")"
[ -n "$release" ] && release_is_complete "$release" ||
  die "no complete release to preview — run without --no-build"

say "Starting $PREVIEW_UNIT on $preview_url"
echo "release:  $(basename "$release")"
echo "base dir: $PREVIEW_BASE_DIR"

systemctl --user stop "$PREVIEW_UNIT" 2>/dev/null || true
systemctl --user reset-failed "$PREVIEW_UNIT" 2>/dev/null || true
mkdir -p "$PREVIEW_BASE_DIR"

systemd-run --user --unit "$PREVIEW_UNIT" \
  --description "T3 Code preview server" \
  --working-directory "$HOME" \
  --setenv=HOME="$HOME" \
  --setenv=PATH="$PATH" \
  "$NODE_BIN" "$release/dist/bin.mjs" serve \
  --host "$PREVIEW_HOST" --port "$PREVIEW_PORT" \
  --base-dir "$PREVIEW_BASE_DIR" "$PROJECT_DIR" >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 3 "$preview_url/"; then
    say "Preview is up at $preview_url"
    mint_pairing "$release"
    cat <<EOF

The live server on port ${live_port:-3773} is untouched.

  logs:  journalctl --user -u $PREVIEW_UNIT -f
  stop:  $SCRIPT_DIR/preview.sh --stop
EOF
    exit 0
  fi
  sleep 2
done

systemctl --user status "$PREVIEW_UNIT" --no-pager --lines 30 || true
die "preview did not come up on $preview_url"
