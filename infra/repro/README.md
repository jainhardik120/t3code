# Large-thread load repro harness

Reproduces the slow/janky loading of very large chat threads on mobile against a
throwaway server seeded with real large threads — without touching the live
server, and with a fast edit→test loop.

## What's here

- `seed-fixture.sh` — builds a compact fixture DB from a real `state.sqlite`,
  keeping only a few large threads (+ their project), stripping auth/device rows.
- `docker-compose.yml` — runs the T3 server (from the host-built bundle) against
  the fixture, reachable by an Android emulator.
- `.data/` — the generated fixture base-dir (gitignored).

## Why it's shaped this way

- The server **bundle isn't standalone** — it externalizes npm deps and uses
  pnpm's relative symlinks, so the container mounts the **whole repo** read-only
  and runs `apps/server/dist/bin.mjs` from its natural path.
- The host is Ubuntu 26.04 (**glibc 2.43**); host-compiled `node-pty` won't load
  on standard `node:*` images (older glibc). So the container uses
  `ubuntu:26.04` + the **host's Node runtime** (both glibc-compatible). The DB
  uses `node:sqlite` (built in), so no native DB module is needed.

## 1. Seed the fixture (once)

```bash
infra/repro/seed-fixture.sh ~/.t3/userdata/state.sqlite infra/repro/.data
```

Edit the `THREADS=(...)` list in the script to pick which threads to include.
Produces `infra/repro/.data/userdata/state.sqlite` (~200 MB for the two biggest
threads). No full-size copy of the source is ever made.

## 2. Run the server

```bash
docker compose -f infra/repro/docker-compose.yml up -d
docker logs -f t3-repro          # wait for "T3 Code server is ready."
```

Server is on `http://localhost:3810` (host). Sanity check:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3810/ws   # 401 = up
```

### Server edit → test loop (fast)

```bash
# edit apps/server/src/...
vp run --filter t3 build:bundle                              # ~1s
docker compose -f infra/repro/docker-compose.yml restart     # picks up new dist
```

No image rebuild — `dist` is a live bind mount.

## 3. Mobile dev client (fast JS loop)

Build the debug **development** dev-client once (x86_64, no minify — much faster
than a release build):

```bash
cd apps/mobile
APP_VARIANT=development EXPO_NO_GIT_STATUS=1 npx expo prebuild --clean --platform android
cd android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64
adb -s emulator-5554 install -r app/build/outputs/apk/debug/app-debug.apk
```

Point the emulator at the container + Metro, then start Metro:

```bash
adb -s emulator-5554 reverse tcp:3810 tcp:3810   # server
adb -s emulator-5554 reverse tcp:8081 tcp:8081   # Metro
cd apps/mobile && APP_VARIANT=development npx expo start --dev-client
```

In the app: **Add environment** → host `http://localhost:3810`, pairing code
from:

```bash
docker exec t3-repro /hostnode/bin/node /repo/apps/server/dist/bin.mjs \
  auth pairing create --base-dir /data --base-url http://localhost:3810
```

Open a seeded thread to reproduce the slow load.

**JS/TS edits (the thread-loading fix) hot-reload in ~1s over Metro — no
rebuild.** Only re-run the native build if native deps/config change.

## Measuring the load (on-device)

```bash
# blank-screen duration: sample the screen while opening a big thread
# app CPU/RAM while it churns:
adb -s emulator-5554 shell top -n 1 -b | grep t3tools
# raw snapshot cost server-side:
curl -s -o /dev/null -w "size=%{size_download} time=%{time_total}s\n" \
  -H "authorization: Bearer <token>" \
  http://localhost:3810/api/orchestration/threads/<threadId>
```
