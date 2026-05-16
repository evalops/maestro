# A2A tmux smoke

`scripts/smoke-maestro-a2a-tmux.sh` is the local end-to-end smoke for native
Maestro A2A pairing. It launches two local Maestro control-plane peers in tmux,
uses the TypeScript `maestro a2a` CLI to exchange pairing codes, stores each
peer in an isolated registry, then verifies both `send --wait` and explicit
`wait`.

Run it from the repo root:

```sh
bash scripts/smoke-maestro-a2a-tmux.sh
```

The harness deliberately avoids the legacy Python relay. The only A2A client
entrypoint it drives is:

```sh
bun run a2a -- offer ...
bun run a2a -- accept ...
bun run a2a -- peers
bun run a2a -- send ...
bun run a2a -- wait ...
```

## What it proves

- Two real local Maestro HTTP A2A endpoints are running in tmux.
- Pairing codes are generated from each peer's Agent Card.
- Each side accepts the other side into an isolated
  `MAESTRO_A2A_PEERS_FILE` registry.
- Peer A can send to peer B and block with bounded `send --wait`.
- Peer B can send to peer A, parse the returned task id, and complete a bounded
  explicit `wait`.

The local peers use `MAESTRO_A2A_FAKE_RESPONSE` so the smoke validates A2A
transport, task storage, registry lookup, and CLI orchestration without spending
model tokens or requiring external provider credentials.

## Useful knobs

```sh
MAESTRO_A2A_TMUX_SESSION=maestro-a2a-smoke-2 bash scripts/smoke-maestro-a2a-tmux.sh
MAESTRO_A2A_TMUX_KEEP_SESSION=1 bash scripts/smoke-maestro-a2a-tmux.sh
MAESTRO_A2A_TMUX_READY_TIMEOUT_SECONDS=180 bash scripts/smoke-maestro-a2a-tmux.sh
```

By default the script kills the tmux session on exit. Set
`MAESTRO_A2A_TMUX_KEEP_SESSION=1` to inspect the peer panes after a failure.
Logs and temporary peer registries are written under `tmp/a2a-tmux-smoke/`.

## Expected output

A successful run ends with:

```text
tmux A2A smoke passed
  session: maestro-a2a-smoke
  peer-a:  http://127.0.0.1:<port>
  peer-b:  http://127.0.0.1:<port>
  logs:    .../tmp/a2a-tmux-smoke/logs
```

If the smoke fails before readiness, inspect the tmux panes or the captured
logs. The most common local blocker is the first Rust compile taking longer
than the default readiness timeout.
