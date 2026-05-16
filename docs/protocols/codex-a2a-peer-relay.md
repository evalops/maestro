# Codex A2A Peer Relay

`scripts/codex-a2a-peer.py` lets a fleet host initiate A2A handoffs to other
Codex bridge peers without an operator brokering each `message:send` call.

Create a local registry at `~/.codex/fleet/peers.json`:

```json
{
  "defaultPeer": "mac-mini",
  "timeoutMs": 600000,
  "peers": {
    "dev-desktop": {
      "url": "http://192.168.4.113:18787",
      "tokenFile": "~/.codex/fleet/dev-desktop.token"
    },
    "mac-mini": {
      "url": "http://192.168.4.53:18787",
      "tokenFile": "~/.codex/fleet/mac-mini.token"
    }
  }
}
```

Use token files or `tokenEnv`; avoid committing inline `token` values. The relay
sends `Authorization: Bearer ...` and `A2A-Version: 1.0` on every request.

Common commands:

```sh
python3 scripts/codex-a2a-peer.py list
python3 scripts/codex-a2a-peer.py card mac-mini
python3 scripts/codex-a2a-peer.py send --from dev-desktop mac-mini "Validate the desktop sign-in flow on macOS"
python3 scripts/codex-a2a-peer.py send --wait --from dev-desktop mac-mini "Validate the desktop sign-in flow on macOS"
python3 scripts/codex-a2a-peer.py relay dev-desktop --stdin < handoff.md
python3 scripts/codex-a2a-peer.py task mac-mini codex-a2a-task-123
python3 scripts/codex-a2a-peer.py wait mac-mini codex-a2a-task-123 --max-wait 300
python3 scripts/codex-a2a-peer.py cancel mac-mini codex-a2a-task-123
```

For async work, pass `--async`; the command prints the task id and current state,
which can be polled later with `task`, waited on with `wait`, or stopped with
`cancel`. For one-shot handoffs where the caller wants the final answer but
still needs bounded polling, pass `send --wait`; it requests an async task and
then polls `GET /tasks/{id}` until the task leaves `TASK_STATE_SUBMITTED` or
`TASK_STATE_WORKING`. `wait` and `send --wait` are bounded by `--max-wait`
(default: 300 seconds) and sleep between polls with `--interval` or
`--wait-interval` (default: 5 seconds), so they are safe for fleet scripts that
must not run unbounded watchers.

When the bridge receives relay metadata, it prepends a small prompt envelope so
the receiving Codex turn can see routing/correlation context without the caller
repeating it in the user text. Only scalar allowlisted fields are rendered:
`actorId`, `agentId`, `handoffFrom`, `relayPeer`, `relaySentAt`, `requestKind`,
`sessionId`, `workspaceId`, plus normalized `taskId`, `contextId`, and
`messageId`. Finite scalar values are capped before rendering; headers, tokens,
configuration, and arbitrary metadata are never copied into the prompt.
