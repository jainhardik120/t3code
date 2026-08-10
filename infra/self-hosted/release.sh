#!/usr/bin/env bash
# Step 2 of the self-hosted upgrade recipe: build, package standalone, restart.
#
#   ./infra/self-hosted/release.sh                # full release
#   ./infra/self-hosted/release.sh --no-restart   # build + package, don't touch the service
#   ./infra/self-hosted/release.sh --finish-release <dir>   # (internal) swap + restart only
#
# Produces a self-contained release under ~/.local/share/t3code/releases/<stamp>,
# flips the `current` symlink, restarts the systemd unit, and rolls back
# automatically if the new release fails its health check.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="$REPO_ROOT/infra/self-hosted/release.sh"
DEPLOY_ROOT="${T3_DEPLOY_ROOT:-$HOME/.local/share/t3code}"
RELEASES_DIR="$DEPLOY_ROOT/releases"
CURRENT_LINK="$DEPLOY_ROOT/current"
SERVICE="${T3_SERVICE:-t3code}"
HEALTH_URL="${T3_HEALTH_URL:-http://127.0.0.1:3773/}"
KEEP_RELEASES="${T3_KEEP_RELEASES:-3}"
RESTART=1
FINISH_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --no-restart) RESTART=0 ;;
    --finish-release) FINISH_DIR="${2:?--finish-release needs a directory}"; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Swap the symlink, restart, health check, roll back on failure, prune.
#
# Split into its own entry point because restarting the service kills every
# process in its cgroup — including this script, when it is run from a terminal
# or agent session hosted by t3code itself. See the dispatcher at the bottom.
# ---------------------------------------------------------------------------
finish_release() {
  local release_dir="$1"
  [ -d "$release_dir" ] || die "no such release: $release_dir"

  local previous=""
  if [ -L "$CURRENT_LINK" ]; then previous="$(readlink -f "$CURRENT_LINK")"; fi

  local exec_start
  exec_start="$(systemctl --user show "$SERVICE" -p ExecStart --value 2>/dev/null || true)"
  case "$exec_start" in
    *"$CURRENT_LINK"*) ;;
    "") die "systemd unit '$SERVICE' not found — run ./infra/self-hosted/install-service.sh first" ;;
    *) die "unit '$SERVICE' does not run from $CURRENT_LINK — run ./infra/self-hosted/install-service.sh first" ;;
  esac

  say "Pointing current -> $release_dir and restarting $SERVICE"
  ln -sfn "$release_dir" "$CURRENT_LINK.tmp"
  mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"
  systemctl --user restart "$SERVICE"

  say "Health check"
  local healthy=0
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null --max-time 3 "$HEALTH_URL"; then healthy=1; break; fi
    sleep 2
  done

  if [ "$healthy" -ne 1 ]; then
    warn "health check failed against $HEALTH_URL"
    if [ -n "$previous" ] && [ -d "$previous" ]; then
      warn "rolling back to $previous"
      ln -sfn "$previous" "$CURRENT_LINK.tmp"
      mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"
      systemctl --user restart "$SERVICE"
      sleep 3
    fi
    echo
    systemctl --user status "$SERVICE" --no-pager --lines 30 || true
    die "release failed; see 'journalctl --user -u $SERVICE -n 100'"
  fi

  say "Pruning old releases (keeping $KEEP_RELEASES)"
  local keep_target
  keep_target="$(readlink -f "$CURRENT_LINK")"
  # shellcheck disable=SC2012
  ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | tail -n +"$((KEEP_RELEASES + 1))" | while read -r old; do
    old="${old%/}"
    [ "$(readlink -f "$old")" = "$keep_target" ] && continue
    echo "removing $old"
    rm -rf "$old"
  done

  say "Live on $(basename "$release_dir")"
  cat "$release_dir/RELEASE_INFO" 2>/dev/null || true
}

if [ -n "$FINISH_DIR" ]; then
  finish_release "$FINISH_DIR"
  exit 0
fi

cd "$REPO_ROOT"

# --- preflight -------------------------------------------------------------

say "Preflight"
[ -z "$(git ls-files -u)" ] || die "unresolved merge conflicts — finish the merge first"
command -v vp >/dev/null || die "vp (vite-plus) not on PATH"
command -v pnpm >/dev/null || die "pnpm not on PATH"

sha="$(git rev-parse --short HEAD)"
branch="$(git rev-parse --abbrev-ref HEAD)"
stamp="$(date +%Y%m%d-%H%M%S)"
release_dir="$RELEASES_DIR/$stamp-$sha"
echo "branch=$branch sha=$sha -> $release_dir"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  warn "working tree has uncommitted changes — they WILL be included in this release"
fi

# --- dependencies ----------------------------------------------------------
#
# Run install explicitly. Never let a `pnpm run` deps-status check do it for us:
# that path re-invokes `pnpm install --production`, which considers the dev
# node_modules incompatible and asks to delete it.

say "Installing dependencies"
pnpm install

# --- build -----------------------------------------------------------------
#
# `vp run --filter t3 build` runs apps/server/scripts/cli.ts build, which packs
# dist/bin.mjs and copies apps/web/dist into apps/server/dist/client. Use vp, not
# `pnpm --filter t3 build` (see above).

say "Building server + web client"
vp run --filter t3 build

[ -f apps/server/dist/bin.mjs ] || die "build produced no apps/server/dist/bin.mjs"
[ -f apps/server/dist/client/index.html ] ||
  die "build produced no apps/server/dist/client/index.html — the web bundle did not make it in"

# --- package standalone ----------------------------------------------------
#
# --legacy is required: the workspace does not set inject-workspace-packages,
# and pnpm >=10 refuses to deploy without it. --prod drops devDependencies;
# everything the bundle actually imports at runtime (effect, the agent SDK,
# node-pty's native binding) is a prod dep.

say "Packaging standalone release"
rm -rf "$release_dir"
mkdir -p "$RELEASES_DIR"
pnpm --filter t3 deploy --prod --legacy "$release_dir"

[ -f "$release_dir/dist/client/index.html" ] || die "release is missing the web client"
[ -f "$release_dir/node_modules/node-pty/build/Release/pty.node" ] ||
  die "release is missing node-pty's native binding"

git log -1 --format='%H%n%s%n%ad' --date=iso > "$release_dir/RELEASE_INFO"
echo "branch: $branch" >> "$release_dir/RELEASE_INFO"

say "Smoke testing the packaged binary"
node "$release_dir/dist/bin.mjs" --version

if [ "$RESTART" -eq 0 ]; then
  say "Built and packaged at $release_dir (--no-restart; service untouched)"
  echo "Finish later with: $SELF --finish-release $release_dir"
  exit 0
fi

# --- restart ---------------------------------------------------------------
#
# If this shell lives inside the service's own cgroup (a terminal or agent
# session hosted by the running t3code), restarting from here would kill this
# script mid-flight, so the health check and auto-rollback would never run. Hand
# the last phase to a transient unit owned by the user manager instead.

if grep -qs "$SERVICE.service" /proc/self/cgroup; then
  unit="t3code-release-$stamp"
  say "This shell runs inside $SERVICE.service — handing off restart to $unit"
  systemd-run --user --collect --unit "$unit" \
    --description "T3 Code release $stamp" \
    /usr/bin/env bash "$SELF" --finish-release "$release_dir"
  cat <<EOF

Restart is running detached; this session is about to be killed by it.
Follow along from a shell outside the service:

    journalctl --user -u $unit -f
    systemctl --user status $SERVICE

Rollback if needed: ./infra/self-hosted/rollback.sh
EOF
  exit 0
fi

finish_release "$release_dir"

echo
echo "If contracts (packages/contracts) changed, the Android APK needs a rebuild too —"
echo "the mobile client talks the same RPC schema."
