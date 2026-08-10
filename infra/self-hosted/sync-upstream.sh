#!/usr/bin/env bash
# Step 1 of the self-hosted upgrade recipe: pull upstream into the integration branch.
#
#   ./infra/self-hosted/sync-upstream.sh
#
# Fetches origin, merges origin/main into the integration branch, and stops with
# instructions if there are conflicts. Resolve them by hand, `git commit`, then
# run release.sh. See README.md for the conflict rules that keep recurring.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INTEGRATION_BRANCH="${T3_INTEGRATION_BRANCH:-feat/android-fcm-push}"

cd "$REPO_ROOT"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

current_branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$current_branch" = "$INTEGRATION_BRANCH" ] ||
  die "on '$current_branch', expected '$INTEGRATION_BRANCH' (override with T3_INTEGRATION_BRANCH)"

if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "working tree is dirty — commit or stash before syncing"
fi

say "Fetching origin"
git fetch origin

behind="$(git rev-list --count HEAD..origin/main)"
if [ "$behind" -eq 0 ]; then
  say "Already up to date with origin/main — nothing to merge"
  exit 0
fi

say "$behind new upstream commits; recording pre-merge state"
git tag -f "premerge/$(date +%Y%m%d-%H%M%S)" HEAD >/dev/null
echo "Recovery: git reset --hard $(git rev-parse --short HEAD) undoes the merge."

say "Merging origin/main into $INTEGRATION_BRANCH"
if git merge origin/main --no-edit; then
  say "Merged cleanly"
else
  cat <<'EOF'

Merge stopped on conflicts. Resolve them by hand, then:

    git add -A && git commit --no-edit

Conflict rules that keep recurring (details in infra/self-hosted/README.md):
  * Migrations — an id already applied in the live DB keeps its id AND name.
    Check with:
      sqlite3 ~/.t3/userdata/state.sqlite \
        'select migration_id, name from effect_sql_migrations order by migration_id desc limit 5;'
    Renumber the INCOMING upstream migration to the next free id, and update
    apps/server/src/persistence/Migrations.ts plus the file name and test.
  * Take both sides on registries (ws.ts handlers, RpcAuthorization.ts,
    assembleThreadObject, Stack.tsx, ThreadFeed.tsx) — these are lists, not
    either/or choices.

Abort instead with: git merge --abort
EOF
  exit 1
fi

say "Syncing dependencies"
pnpm install

if [ -n "$(git status --porcelain pnpm-lock.yaml)" ]; then
  say "Lockfile changed — committing"
  git add pnpm-lock.yaml
  git commit -m "chore: sync lockfile after upstream merge"
fi

cat <<EOF

Merge complete. Recommended before releasing:

    pnpm --filter t3 typecheck
    pnpm --filter t3 test

Then:

    ./infra/self-hosted/release.sh
EOF
