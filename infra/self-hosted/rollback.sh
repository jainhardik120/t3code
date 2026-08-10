#!/usr/bin/env bash
# Roll the running service back to a previous standalone release.
#
#   ./infra/self-hosted/rollback.sh              # previous release
#   ./infra/self-hosted/rollback.sh <name>       # a specific release directory name
#   ./infra/self-hosted/rollback.sh --list       # what is available
#   ./infra/self-hosted/rollback.sh --foreground # run inline instead of detached
#
# Like release.sh, this runs as a transient systemd user unit by default so the
# service restart cannot kill it midway.
set -euo pipefail

# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
SELF="$SCRIPT_DIR/rollback.sh"

FOREGROUND=0
INLINE=0
TARGET_NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --foreground | -f) FOREGROUND=1 ;;
    --inline) INLINE=1 ;; # internal
    --list)
      cur="$(current_release)"
      prev="$(previous_release)"
      for d in "$RELEASES_DIR"/*/; do
        d="${d%/}"
        [ -d "$d" ] || continue
        mark="  "
        [ "$(readlink -f "$d")" = "$cur" ] && mark="* "
        [ -n "$prev" ] && [ "$(readlink -f "$d")" = "$prev" ] && mark="< "
        release_is_complete "$d" || mark="! "
        printf '%s%-28s %s\n' "$mark" "$(basename "$d")" \
          "$(sed -n 2p "$d/RELEASE_INFO" 2>/dev/null || echo '(no RELEASE_INFO)')"
      done
      echo
      echo "* = live   < = rollback target   ! = incomplete"
      exit 0
      ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) TARGET_NAME="$1" ;;
  esac
  shift
done

if [ -n "$TARGET_NAME" ]; then
  target="$(readlink -f "$RELEASES_DIR/$TARGET_NAME" 2>/dev/null || true)"
else
  target="$(previous_release)"
  # No PREVIOUS marker (e.g. a release predating it) — fall back to the newest
  # complete release that is not the live one.
  if [ -z "${target:-}" ]; then
    cur="$(current_release)"
    # shellcheck disable=SC2012
    while read -r d; do
      d="$(readlink -f "${d%/}")"
      [ "$d" = "$cur" ] && continue
      release_is_complete "$d" || continue
      target="$d"
      break
    done < <(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null)
  fi
fi

[ -n "${target:-}" ] && [ -d "$target" ] || {
  echo "no release to roll back to. Available:" >&2
  "$SELF" --list >&2 || true
  exit 1
}
release_is_complete "$target" || die "release $target is incomplete — refusing to activate it"
[ "$target" != "$(current_release)" ] || die "already live on $(basename "$target")"

if [ "$FOREGROUND" -eq 1 ] || [ "$INLINE" -eq 1 ]; then
  say "Rolling back to $(basename "$target")"
  cat "$target/RELEASE_INFO" 2>/dev/null || true
  activate "$target"
else
  echo "Rolling back to $(basename "$target")"
  detach "t3code-rollback-$(date +%Y%m%d-%H%M%S)" "$SELF" --inline "$(basename "$target")"
fi
