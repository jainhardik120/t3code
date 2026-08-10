# Self-hosted upgrade recipe

How to pull upstream changes into the self-hosted server at `t3.hardikja.in` while
keeping the two local features (Android FCM push, windowed thread loading), and
ship the result to the running systemd service.

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

`feat/android-fcm-push` is **the integration branch and the source of truth.** It
already contains both features, as one checkpoint commit (`4f4637f62`) plus
subsequent upstream merges.

The two branches that look like the features are historical forks, checked out in
worktrees:

| branch                         | worktree               | status                                    |
| ------------------------------ | ---------------------- | ----------------------------------------- |
| `feat/android-fcm-push`        | `~/code/t3code`        | integration branch — merge here           |
| `feat/fcm-push`                | `~/code/t3code-fcm`    | single commit off `202e5609f`, superseded |
| `feat/windowed-thread-loading` | `~/code/t3code-window` | single commit off `202e5609f`, superseded |

Both forks are strict subsets of the checkpoint (they differ only by explanatory
comments that the checkpoint has and they don't). **Do not merge them into the
integration branch** — there is nothing in them to gain, and doing so produces
conflicts on every file both touch. They exist for reference and for opening
upstream PRs; if you don't want them, deleting them loses nothing.

So "merge our two branches into upstream" is really: **merge `origin/main` into
`feat/android-fcm-push`.** One merge.

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
- `assembleThreadObject` — projection field assembly
- `apps/mobile/src/Stack.tsx`, `apps/mobile/src/features/threads/ThreadFeed.tsx`
- `packages/contracts/src/rpc.ts` — RPC group members

**Interleaved test files.** `ProjectionSnapshotQuery.test.ts` and `server.test.ts`
collect tests from both features and from upstream; conflicts there need the test
cases from both sides kept side by side, not one side chosen.

Sanity check after resolving:

```
pnpm --filter t3 typecheck
pnpm --filter t3 test
```

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
