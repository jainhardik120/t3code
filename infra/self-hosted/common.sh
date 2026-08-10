# shellcheck shell=bash
# Shared configuration and helpers for the self-hosted release scripts.
# Sourced by release.sh and rollback.sh — not executable on its own.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/infra/self-hosted"
DEPLOY_ROOT="${T3_DEPLOY_ROOT:-$HOME/.local/share/t3code}"
RELEASES_DIR="$DEPLOY_ROOT/releases"
CURRENT_LINK="$DEPLOY_ROOT/current"
SERVICE="${T3_SERVICE:-t3code}"
HEALTH_URL="${T3_HEALTH_URL:-http://127.0.0.1:3773/}"
HEALTH_ATTEMPTS="${T3_HEALTH_ATTEMPTS:-30}"
KEEP_RELEASES="${T3_KEEP_RELEASES:-3}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- background execution --------------------------------------------------
#
# Anything that restarts the service must not run inside the service's own
# cgroup: `systemctl restart` kills every process in it, including terminals and
# agent sessions hosted by the running t3code — which would kill the deploy
# script mid-flight, leaving the health check and rollback unrun. Everything
# therefore runs as a transient user-manager unit by default.

# detach <unit-name> <command...>
detach() {
  local unit="$1"; shift
  local setenv=(--setenv=PATH="$PATH" --setenv=HOME="$HOME")
  local var
  for var in $(compgen -v | grep '^T3_' || true); do
    setenv+=("--setenv=$var=${!var}")
  done

  systemd-run --user --unit "$unit" \
    --description "T3 Code self-hosted deploy ($unit)" \
    --working-directory "$REPO_ROOT" \
    "${setenv[@]}" \
    /usr/bin/env bash "$@" >/dev/null

  cat <<EOF

Running in the background as user unit: $unit

  follow:  journalctl --user -u $unit -f
  status:  systemctl --user status $unit
  service: systemctl --user status $SERVICE

If this shell is hosted by t3code it will be killed when the service restarts;
the unit above keeps going, health-checks, and rolls back on failure.
EOF
}

# --- release plumbing ------------------------------------------------------

release_is_complete() {
  local dir="$1"
  [ -f "$dir/dist/bin.mjs" ] && [ -f "$dir/dist/client/index.html" ] &&
    [ -f "$dir/node_modules/node-pty/build/Release/pty.node" ]
}

current_release() { readlink -f "$CURRENT_LINK" 2>/dev/null || true; }

# The release `current` pointed at before the last swap; the rollback target.
previous_release() {
  local cur
  cur="$(current_release)"
  [ -n "$cur" ] && [ -f "$cur/PREVIOUS" ] || return 0
  local prev
  prev="$(cat "$cur/PREVIOUS")"
  [ -d "$prev" ] && echo "$prev"
}

point_current_at() {
  local target="$1"
  ln -sfn "$target" "$CURRENT_LINK.tmp"
  mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"
}

assert_unit_uses_symlink() {
  local exec_start
  exec_start="$(systemctl --user show "$SERVICE" -p ExecStart --value 2>/dev/null || true)"
  case "$exec_start" in
    *"$CURRENT_LINK"*) return 0 ;;
    "") die "systemd unit '$SERVICE' not found — run $SCRIPT_DIR/install-service.sh first" ;;
    *) die "unit '$SERVICE' does not run from $CURRENT_LINK — run $SCRIPT_DIR/install-service.sh first" ;;
  esac
}

wait_healthy() {
  local i
  for ((i = 0; i < HEALTH_ATTEMPTS; i++)); do
    if curl -fsS -o /dev/null --max-time 3 "$HEALTH_URL"; then return 0; fi
    sleep 2
  done
  return 1
}

# activate <release-dir> — swap, restart, health check, roll back on failure.
activate() {
  local target="$1"
  release_is_complete "$target" || die "incomplete release, refusing to activate: $target"
  assert_unit_uses_symlink

  local previous
  previous="$(current_release)"

  if [ -n "$previous" ] && [ "$previous" != "$target" ]; then
    echo "$previous" > "$target/PREVIOUS"
  fi

  say "Pointing current -> $target and restarting $SERVICE"
  point_current_at "$target"
  systemctl --user restart "$SERVICE"

  say "Health check ($HEALTH_URL)"
  if wait_healthy; then
    say "Healthy on $(basename "$target")"
    cat "$target/RELEASE_INFO" 2>/dev/null || true
    return 0
  fi

  warn "health check failed after $((HEALTH_ATTEMPTS * 2))s"
  systemctl --user status "$SERVICE" --no-pager --lines 40 || true

  if [ -z "$previous" ] || [ "$previous" = "$target" ]; then
    die "no previous release to roll back to — service is down on $(basename "$target")"
  fi
  if ! release_is_complete "$previous"; then
    die "previous release $previous is incomplete — cannot auto-roll back"
  fi

  warn "rolling back to $(basename "$previous")"
  point_current_at "$previous"
  systemctl --user restart "$SERVICE"

  if wait_healthy; then
    die "release $(basename "$target") failed its health check; rolled back to $(basename "$previous")"
  fi
  die "release failed AND rollback is unhealthy — inspect 'journalctl --user -u $SERVICE -n 200'"
}

# Keep the newest N, and never delete what `current` points at or its rollback target.
prune_releases() {
  say "Pruning old releases (keeping $KEEP_RELEASES)"
  local keep_current keep_previous old
  keep_current="$(current_release)"
  keep_previous="$(previous_release)"
  # shellcheck disable=SC2012
  ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | tail -n +"$((KEEP_RELEASES + 1))" | while read -r old; do
    old="${old%/}"
    old="$(readlink -f "$old")"
    [ "$old" = "$keep_current" ] && continue
    [ -n "$keep_previous" ] && [ "$old" = "$keep_previous" ] && continue
    echo "removing $(basename "$old")"
    rm -rf "$old"
  done
}
