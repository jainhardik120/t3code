# Self-hosted upgrade recipe

How to pull upstream changes into the self-hosted server at `t3.hardikja.in` while
keeping the local Android FCM push feature, and ship the result to the running
systemd service.

```
./infra/self-hosted/sync-upstream.sh     # fetch + merge origin/main (may stop on conflicts)
#   ... resolve conflicts by hand, git add -A && git commit --no-edit ...
pnpm --filter t3 typecheck                # optional but cheap
./infra/self-hosted/release.sh           # build, package standalone, restart, health check
```

One-time, before the first `release.sh`:

```
./infra/self-hosted/install-service.sh   # repoint the systemd unit at the release symlink
```

---

## Branch layout — read this before merging anything

`feat/android-fcm-push` is **the integration branch and the source of truth.**

There is now exactly **one** local feature on it: self-hosted Android FCM push.
The windowed-thread-loading feature was retired on 2026-08-10 — upstream shipped
its own turn-based pagination (`OrchestrationThreadDetailWindow` / `page` /
`beforeCursor`, in the shared `packages/client-runtime`), so ours was dropped in
favour of it rather than carried as a permanent conflict. **Do not resurrect it**;
if large threads regress, fix it in upstream's pagination.

The branches that look like the features are historical forks, checked out in
worktrees:

| branch                         | worktree               | status                                    |
| ------------------------------ | ---------------------- | ----------------------------------------- |
| `feat/android-fcm-push`        | `~/code/t3code`        | integration branch — merge here           |
| `feat/fcm-push`                | `~/code/t3code-fcm`    | single commit off `202e5609f`, superseded |
| `feat/windowed-thread-loading` | `~/code/t3code-window` | **retired** — replaced by upstream's      |

Both forks are strict subsets of the integration branch. **Do not merge them into
it** — there is nothing in them to gain, and doing so produces conflicts on every
file both touch. They exist for reference; deleting them loses nothing.

So the upgrade is really: **merge `origin/main` into `feat/android-fcm-push`.**
One merge.

## Step 1 — sync upstream

```
./infra/self-hosted/sync-upstream.sh
```

Requires a clean tree and that you're on the integration branch. It records the
pre-merge commit as `refs/premerge/<stamp>` first, so

```
git for-each-ref --format='%(refname) %(objectname:short)' refs/premerge
git reset --hard <that sha>
```

always gets you back. (A ref, not a tag — this repo sets `tag.gpgsign`, which
makes `git tag` demand a message and a signing key.)

### Conflict rules that keep recurring

**Migrations — the live database is the authority.** Ours (`035_PushDevices`) and
upstream's collide because both claim the next free id. The applied ledger wins:

```
sqlite3 ~/.t3/userdata/state.sqlite \
  'select migration_id, name from effect_sql_migrations order by migration_id desc limit 5;'
```

Any `(id, name)` pair already in that table must keep **both** its id and its name
— renumbering an applied migration means the runner sees an unapplied id and
re-runs it against a schema that already has the change. Renumber the _incoming_
upstream migration to the next free id instead. As of `36|ProjectionThreadTitleRegeneration`,
every upstream migration is effectively offset by +1 from its upstream number.
Renumbering touches four places: the file name under
`apps/server/src/persistence/Migrations/`, its `.test.ts` sibling, the import and
the record entry in `apps/server/src/persistence/Migrations.ts`.

**Registries take both sides.** These files are lists, not either/or choices —
conflicts in them almost always resolve to "keep ours _and_ theirs":

- `apps/server/src/ws.ts` — handler map
- `apps/server/src/auth/RpcAuthorization.ts` — per-RPC authorization entries
- `packages/contracts/src/rpc.ts` and `packages/contracts/src/index.ts`
- `apps/mobile/src/Stack.tsx`

**Everything else should be upstream's.** With windowing retired, the only local
code is the push feature. Its footprint is small and mostly in files upstream
never touches:

```
apps/server/src/push/                     packages/contracts/src/push.ts
apps/server/src/persistence/PushDevices*  packages/client-runtime/src/state/push.ts
apps/server/src/persistence/Migrations/035_PushDevices.ts
apps/server/src/cli/push.ts               apps/mobile/src/state/push.ts
apps/mobile/src/features/agent-awareness/{notificationPermissions,notificationSetup,useAndroidPushRegistration}.ts
docs/user/push-notifications.md
```

A conflict in a file outside that list and outside the registries above is almost
certainly upstream-vs-upstream churn — take `origin/main`'s version
(`git checkout origin/main -- <file>`) rather than hand-merging it.

**server.test.ts** is the one file both the push feature and upstream edit
heavily; it needs its mock of `ProjectionSnapshotQuery` to match the current
service interface exactly, since extra keys are a type error.

Sanity check after resolving:

```
vp run -r --concurrency-limit 2 typecheck                  # whole workspace
GIT_CONFIG_GLOBAL=/dev/null vp run --filter t3 test        # server suite
```

`GIT_CONFIG_GLOBAL=/dev/null` matters on this host: `~/.gitconfig` sets a global
`core.hooksPath`, which overrides the per-repo hooks that `GitManager.test.ts`
installs into its temp repos — so two hook-rejection tests fail for reasons that
have nothing to do with your merge. Renumbering also breaks any migration test
that hardcodes ids (`runMigrations({ toMigrationInclusive: N })`); bump those by
the same offset as the file.

## Step 2 — release

```
./infra/self-hosted/release.sh
```

1. `pnpm install`
2. `vp run --filter t3 build` — builds `apps/web`, packs `apps/server/dist/bin.mjs`,
   copies the web bundle to `apps/server/dist/client`
3. `pnpm --filter t3 deploy --prod --legacy ~/.local/share/t3code/releases/<stamp>-<sha>`
4. smoke test (`dist/bin.mjs --version`)
5. flip `~/.local/share/t3code/current` → new release, `systemctl --user restart t3code`
6. health check `GET http://127.0.0.1:3773/`; **auto-rollback** to the previous
   release if it fails
7. prune to the last 3 releases

### It runs in the background, as a systemd unit

`systemctl restart` kills every process in the service's cgroup — which includes
any terminal or agent session running _inside_ T3 Code. A release driven from
there would be killed at the moment it restarts the service, so the health check
and auto-rollback would never run.

So `release.sh` and `rollback.sh` re-launch themselves as a transient unit owned
by the **user manager**, outside the service cgroup, and return immediately. The
work continues even though the shell that started it is gone:

```
./infra/self-hosted/release.sh          # starts t3code-release-<stamp>, returns
./infra/self-hosted/release.sh --follow # tail the newest release unit
journalctl --user -u t3code-release-<stamp> -f
systemctl --user status t3code-release-<stamp>
```

Other flags:

| flag               | effect                                                           |
| ------------------ | ---------------------------------------------------------------- |
| `--foreground`     | run inline and block; only safe from a shell outside the service |
| `--no-restart`     | build and package, leave the service alone                       |
| `--activate <dir>` | skip the build, just point `current` at an existing release      |
| `--follow`         | tail the newest release unit's journal                           |

### Never run `pnpm --filter t3 build`

It looks equivalent to the `vp run` line above. It is not: pnpm's deps-status
check fires first, decides the workspace is stale, and re-invokes
`pnpm install --production` — which finds the dev `node_modules` incompatible and
asks to **delete the whole 11 GB modules directory**. With no TTY it aborts; in
your terminal it prompts, and answering yes takes the server's dependencies out
from under it. Always `pnpm install` explicitly, then build through `vp run`.

## Why standalone releases

`apps/server/dist/bin.mjs` is not self-contained. `apps/server/vite.config.ts`
bundles only workspace packages (`@t3tools/*`, `@pierre/diffs`, `effect-acp`,
`effect-codex-app-server`); everything else — `effect`, the Claude Agent SDK,
`@opencode-ai/sdk`, `yaml`, and `node-pty` with its native `pty.node` — stays a
bare import resolved from `node_modules` at runtime. The web UI is resolved the
same way: `resolveStaticDir` (`apps/server/src/config.ts:206`) prefers
`dist/client` and falls back to `../../web/dist`.

Running the unit straight out of the checkout therefore meant the live server
depended on the repo's `node_modules` and `apps/web/dist` — so a `pnpm install`,
a branch switch, or a rebuild mutated files underneath a running process, and a
stale `apps/web/dist` silently served an old UI. `pnpm deploy` copies `dist/`
(including `dist/client`) plus a real, non-symlinked prod `node_modules` (~460 MB)
into an immutable release directory. The repo becomes a build tool again.

`--legacy` is mandatory: the workspace doesn't set `inject-workspace-packages`, and
pnpm ≥10 refuses to deploy without it.

## Previewing a build before it replaces production

To look at a change on the running machine without swapping the live server:

```
./infra/self-hosted/preview.sh              # build, launch on :3774, print a pairing link
./infra/self-hosted/preview.sh --no-build   # reuse the newest packaged release
./infra/self-hosted/preview.sh --pair       # another pairing link
./infra/self-hosted/preview.sh --stop
```

It shares nothing with production: its own systemd unit (`t3code-preview`), its
own port, and its own base dir (`~/.t3-preview`), so its database, settings and
pairings are separate — and it refuses to start on the live port or base dir.
Because the state dir is separate you have to pair once; the script mints the
link for you.

The `current` symlink is never touched, so the live server keeps serving the
release it was already on. When the preview looks right, `release.sh` promotes
the same build for real.

Note it is a *second* server against the same machine: both scan the same
provider transcript directories for usage, and both can drive agents in
`~/code`. Don't run turns in both at once on the same worktree.

## Reclaiming disk space

Once a release is live the checkout is only a build tool, so its generated
directories can go:

```
./infra/self-hosted/cleanup.sh --dry-run   # show targets and sizes
./infra/self-hosted/cleanup.sh             # node_modules, dist, .vite-plus, cargo target
./infra/self-hosted/cleanup.sh --all       # + mobile prebuild, pnpm store prune, git gc
```

It refuses to touch anything until it has proved the service can survive without
the repo: a complete live release, a unit whose `ExecStart` does not mention the
repo path, a running process whose command line does not either, and a passing
health check. It then drops any target containing git-tracked files, so a
misjudged path can't leave the worktree full of pending deletions. (`.repos`
looks like a sync cache but its ~13k files are committed — that guard exists
because it got deleted once. `git checkout -- .repos` restores it.) Restore
dependencies with `pnpm install`, which `release.sh` already runs first, so the
next upgrade works from a cleaned tree unchanged.

Measured on 2026-08-10: repo 18 GB → 824 MB, `.git` 3.7 GB → 259 MB, free space
21 GB → 39 GB.

**You can't commit from a cleaned tree.** The repo's pre-commit hook
(`core.hooksPath=.vite-hooks/_`) runs `vp fmt`, which loads `vite-plus` from
`node_modules`, so every commit fails with `Cannot find package 'vite-plus'`.
Either `pnpm install` first, or use `git commit --no-verify` and accept that the
formatter didn't run. Clean after you've finished committing, not before.

Two things are worth knowing before reading the numbers:

**`node_modules` is mostly hardlinks.** pnpm links from the store rather than
copying, so deleting 11 GB of `node_modules` frees far less than 11 GB — the
inodes stay alive in `~/.local/share/pnpm/store` (16 GB here). `--store` runs
`pnpm store prune`, which is what actually returns those bytes. The store is
shared with every pnpm project on the machine, but prune only drops packages
nothing references any more, so other checkouts are unaffected; the cost is
re-downloading on the next install.

**`--mobile` deletes a keystore you cannot regenerate.** `apps/mobile/android`
is gitignored and rebuilt by `expo prebuild`, but `android/app/debug.keystore`
is minted randomly each time. The installed APK is signed with the current one,
and Android refuses an update signed by a different key — so losing it forces an
uninstall, taking app data and pairing with it. The script copies it to
`~/.local/share/t3code/mobile/debug.keystore` first and prints the restore
command; put it back before the next APK build.

## Rollback

```
./infra/self-hosted/rollback.sh --list   # * = live, < = rollback target, ! = incomplete
./infra/self-hosted/rollback.sh          # back to the rollback target
./infra/self-hosted/rollback.sh 20260810-192500-abc1234
```

Each release directory carries two markers: `RELEASE_INFO` (the commit it was
built from) and `PREVIOUS` (the release that was live when it was activated).
Rollback follows `PREVIOUS` rather than guessing from timestamps, so it lands on
the release that was actually running before — and refuses any target that is
incomplete or already live. Rolling back twice returns you to where you started.

`release.sh` performs the same rollback automatically when a new release fails
its health check, and only reports success once the service answers on
`$T3_HEALTH_URL`. Pruning never removes the live release or its rollback target.

Note that rollback does **not** revert database migrations. A release that ran a
new migration and then got rolled back leaves the schema ahead of the code; that's
usually fine (migrations here are additive) but it's the one thing rollback can't
undo.

## After the release

- **Contracts changed?** If `packages/contracts` moved, the Android APK speaks an
  older RPC schema — rebuild and reinstall it. Web clients just need a refresh.
- **Logs:** `journalctl --user -u t3code -f`
- **Status:** `systemctl --user status t3code`
