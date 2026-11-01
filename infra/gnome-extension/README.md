# T3 Monitor (GNOME Shell extension)

Panel indicator for a T3 server on the same machine: running threads, what each is
waiting on, background tasks, and the CPU/memory of each thread's process tree.
It polls `GET /api/orchestration/activity` every 3 seconds.

## Install

```sh
ln -s "$PWD/infra/gnome-extension/t3mon@jainhardik120" ~/.local/share/gnome-shell/extensions/
mkdir -p ~/.config/t3mon
t3 auth session issue --label gnome-panel --ttl 365d --token-only   # copy the token
```

`~/.config/t3mon/config.json`:

```json
{ "serverUrl": "http://127.0.0.1:3773", "token": "<token>", "webUrl": "https://t3.hardikja.in" }
```

On Wayland, log out and back in once so the shell discovers the new extension, then
`gnome-extensions enable t3mon@jainhardik120`. After editing the config, press the
refresh button in the menu.

## Notes

- Per-thread usage relies on `T3CODE_THREAD_ID`, which the Claude adapter sets on its
  CLI process; every descendant inherits it. Shared provider servers (Codex
  app-server, OpenCode) serve several threads and are counted as "Server & shared".
- Process telemetry needs the `t3-resource-monitor` sidecar
  (`native/resource-monitor`, `cargo build --release`) next to the server build.
