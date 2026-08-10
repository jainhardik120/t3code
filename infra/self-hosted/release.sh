#!/usr/bin/env bash
# Step 2 of the self-hosted upgrade recipe: build, package standalone, restart.
#
#   ./infra/self-hosted/release.sh              # background release (default)
#   ./infra/self-hosted/release.sh --foreground # run inline, blocking
#   ./infra/self-hosted/release.sh --no-restart # build + package only
#   ./infra/self-hosted/release.sh --follow     # tail the newest release unit
#   ./infra/self-hosted/release.sh --activate <dir>   # activate an existing release
#
# The default run is a transient systemd user unit, so restarting the service
# cannot kill the deploy that is driving it. See common.sh.
set -euo pipefail

# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
SELF="$SCRIPT_DIR/release.sh"

FOREGROUND=0
RESTART=1
INLINE=0
STAMP=""
ACTIVATE_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --foreground | -f) FOREGROUND=1 ;;
    --no-restart) RESTART=0 ;;
    --activate) ACTIVATE_DIR="${2:?--activate needs a release directory}"; shift ;;
    --follow)
      unit="$(systemctl --user list-units --all --plain --no-legend 't3code-release-*' |
        awk '{print $1}' | sort | tail -1)"
      [ -n "${unit:-}" ] || die "no release unit found"
      exec journalctl --user -u "${unit%.service}" -f
      ;;
    --stamp) STAMP="${2:?}"; shift ;;      # internal
    --inline) INLINE=1 ;;                  # internal: the detached unit's entry point
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -n "$ACTIVATE_DIR" ]; then
  ACTIVATE_DIR="$(readlink -f "$ACTIVATE_DIR")"
  if [ "$FOREGROUND" -eq 1 ] || [ "$INLINE" -eq 1 ]; then
    activate "$ACTIVATE_DIR"
    prune_releases
  else
    detach "t3code-release-$(date +%Y%m%d-%H%M%S)" "$SELF" --inline --activate "$ACTIVATE_DIR"
  fi
  exit 0
fi

cd "$REPO_ROOT"

# --- preflight (cheap, run before detaching so mistakes surface immediately) ---

[ -z "$(git ls-files -u)" ] || die "unresolved merge conflicts — finish the merge first"
command -v vp >/dev/null || die "vp (vite-plus) not on PATH"
command -v pnpm >/dev/null || die "pnpm not on PATH"
[ "$RESTART" -eq 0 ] || assert_unit_uses_symlink

STAMP="${STAMP:-$(date +%Y%m%d-%H%M%S)}"
sha="$(git rev-parse --short HEAD)"
branch="$(git rev-parse --abbrev-ref HEAD)"
release_dir="$RELEASES_DIR/$STAMP-$sha"

if [ "$INLINE" -eq 0 ] && [ "$FOREGROUND" -eq 0 ]; then
  args=(--inline --stamp "$STAMP")
  [ "$RESTART" -eq 0 ] && args+=(--no-restart)
  echo "Releasing $branch @ $sha -> $(basename "$release_dir")"
  detach "t3code-release-$STAMP" "$SELF" "${args[@]}"
  exit 0
fi

say "Preflight"
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
# `pnpm --filter t3 build` (see README).

say "Building server + web client"
vp run --filter t3 build

[ -f apps/server/dist/bin.mjs ] || die "build produced no apps/server/dist/bin.mjs"
[ -f apps/server/dist/client/index.html ] ||
  die "build produced no apps/server/dist/client/index.html — the web bundle did not make it in"

# --- package standalone ----------------------------------------------------
#
# --legacy is required: the workspace does not set inject-workspace-packages,
# and pnpm >=10 refuses to deploy without it. --prod drops devDependencies;
# everything the bundle imports at runtime (effect, the agent SDK, node-pty's
# native binding) is a prod dep.

say "Packaging standalone release"
rm -rf "$release_dir"
mkdir -p "$RELEASES_DIR"
pnpm --filter t3 deploy --prod --legacy "$release_dir"

release_is_complete "$release_dir" ||
  die "packaged release is missing the web client or node-pty's native binding"

{
  git log -1 --format='%H%n%s%n%ad' --date=iso
  echo "branch: $branch"
} > "$release_dir/RELEASE_INFO"

say "Smoke testing the packaged binary"
node "$release_dir/dist/bin.mjs" --version

if [ "$RESTART" -eq 0 ]; then
  say "Built and packaged at $release_dir (--no-restart)"
  echo "Activate later with: $SELF --activate $release_dir"
  exit 0
fi

activate "$release_dir"
prune_releases

cat <<EOF

Released $sha. Rollback with: $SCRIPT_DIR/rollback.sh

If contracts (packages/contracts) changed, the Android APK needs a rebuild too —
the mobile client talks the same RPC schema.
EOF
